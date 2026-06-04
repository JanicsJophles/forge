// ---------------------------------------------------------------------------
// capture: the forge-side stuckpoint capture hook (RAC-378, flywheel 1/4).
// ---------------------------------------------------------------------------
// Called fire-and-forget from runner.ts `proc.on('close')`. It runs the
// heuristic extractor over the task log and POSTs any candidates to the
// agent-board's `/agent-candidates` sink (LXC 207:5000).
//
// HARD CONTRACT (per the agent-board failure-mode rule):
//   - NEVER throws into the caller. Every path is swallowed.
//   - NEVER blocks the task's status transition — the caller does not await.
//   - Board unreachable → silent no-op (coordination degrades, nothing breaks).
//   - Zero candidates for a trivial log → zero network calls (prefilter guard).
// ---------------------------------------------------------------------------

import { extractCandidates } from './extractor.js'
import { config } from '../config.js'

const POST_TIMEOUT_MS = 3000

async function postCandidate(candidate: unknown): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
  try {
    await fetch(`${config.agentBoardUrl}/agent-candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(candidate),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

export interface CaptureContext {
  taskId: string
  repo: string
  exitCode: number | null
}

/**
 * Fire-and-forget: extract stuckpoint candidates from a finished task's log
 * and ship them to the board. Returns the number of candidates emitted (for
 * tests / logging); callers in the hot path should NOT await this.
 */
export async function captureStuckpoints(log: string, ctx: CaptureContext): Promise<number> {
  if (!config.captureEnabled) return 0
  try {
    const candidates = extractCandidates(log, {
      source: 'testing-loop',
      originAgentId: `forge-task-${ctx.taskId}`,
      originRepo: ctx.repo,
      host: 'LXC 207 (forge)',
    })
    if (candidates.length === 0) return 0 // prefilter suppressed cost — no network

    // Best-effort; failures (board down, timeout) are swallowed individually.
    await Promise.allSettled(candidates.map((c) => postCandidate(c)))
    return candidates.length
  } catch {
    // Capture must never break a task. Swallow everything.
    return 0
  }
}
