#!/usr/bin/env node
// ---------------------------------------------------------------------------
// extract-stuckpoints — local Claude Code stuckpoint capture (RAC-378).
// ---------------------------------------------------------------------------
// Drop this in ~/.claude/bin/ and wire it as a `Stop` hook (see README in this
// directory). On session stop, Claude Code pipes a JSON payload on stdin that
// includes `transcript_path` (a JSONL transcript of the session). This script:
//
//   1. reads the transcript,
//   2. runs the SAME heuristic prefilter as the forge runner
//      (apps/runner/src/agent/extractor.ts — keep the two in sync),
//   3. only if real failure signals are present, builds a Candidate and
//      POSTs it to the agent-board `/agent-candidates` sink.
//
// HARD CONTRACT: never throws, never blocks Claude Code, exits 0 always.
// Board unreachable / no API key / trivial session → silent no-op, zero cost.
//
// Zero npm dependencies — pure Node ≥18 (global fetch). No build step.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const BOARD_URL = process.env.AGENT_BOARD_URL ?? 'http://100.105.173.104:5000'
const CAPTURE_ENABLED = process.env.CAPTURE_ENABLED !== 'false'
const POST_TIMEOUT_MS = 3000

// --- heuristic prefilter (mirror of extractor.ts) --------------------------

const RECOVERY_PATTERNS = [
  /that did(?:n't| not) work/,
  /actually,? the (?:real )?(?:issue|problem|cause|fix) (?:is|was)/,
  /turns out/,
  /the (?:real|actual) (?:issue|problem|root cause)/,
  /\bred herring\b/,
  /\bI was wrong\b/,
  /instead,? (?:I|we|you) (?:need|needed|should|had to)/,
  /\bfixed (?:it|by)\b/,
  /\bresolved by\b/,
  /\bthe fix (?:is|was)\b/,
  /\bnow it works\b/,
  /\bworking now\b/,
]

const ERROR_PATTERNS = [
  /\berror\b[:\s]/i,
  /\bfailed\b/i,
  /\bfatal\b/i,
  /\bexception\b/i,
  /\bcommand not found\b/i,
  /\bpermission denied\b/i,
  /\bno such file\b/i,
  /\bconnection refused\b/i,
  /\btimed? out\b/i,
  /\bcannot find\b/i,
  /\btraceback\b/i,
  /\bsegmentation fault\b/i,
  /exited? with (?:code|status) [1-9]/i,
  /\bnon-zero exit\b/i,
]

const EXIT_CODE_PATTERN = /exit(?:ed)?(?: with)?(?: code| status)?\s+([0-9]{1,3})/gi
const COMMAND_LINE_PATTERN =
  /^\s*\$?\s*((?:sudo |COPYFILE_DISABLE=\S+ )?(?:npm|pnpm|yarn|git|docker|pct|ssh|systemctl|tailscale|curl|node|tsc|make|apt|apt-get|kubectl|nginx|qm|zfs|ufw|ip|tar|rsync|ln|chmod|chown|cp|mv|mkdir|cat|sed)\b.*)$/

function isCommandLine(line) {
  const m = line.match(COMMAND_LINE_PATTERN)
  return m ? m[1].trim() : null
}

function detectFailureSignals(log) {
  const lines = log.split(/\r?\n/)
  const nonZeroExits = []
  const errorLines = []
  const recoveryPhrases = []
  const fixLines = []
  const commandLines = []
  const commandCounts = new Map()

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const lower = line.toLowerCase()

    let m
    EXIT_CODE_PATTERN.lastIndex = 0
    while ((m = EXIT_CODE_PATTERN.exec(line)) !== null) {
      const code = parseInt(m[1], 10)
      if (code > 0) nonZeroExits.push(code)
    }
    if (ERROR_PATTERNS.some((re) => re.test(line))) errorLines.push(line)
    if (RECOVERY_PATTERNS.some((re) => re.test(lower))) {
      recoveryPhrases.push(line)
      fixLines.push(line)
    }
    const cmd = isCommandLine(line)
    if (cmd) {
      commandLines.push(cmd)
      commandCounts.set(cmd, (commandCounts.get(cmd) ?? 0) + 1)
    }
  }

  const retriedCommands = [...commandCounts.entries()].filter(([, n]) => n >= 2).map(([c]) => c)
  const hasSignal =
    nonZeroExits.length > 0 ||
    errorLines.length > 0 ||
    retriedCommands.length > 0 ||
    recoveryPhrases.length > 0

  return { hasSignal, nonZeroExits, errorLines, retriedCommands, recoveryPhrases, fixLines, commandLines }
}

function severityFor(s) {
  if (s.errorLines.some((l) => /fatal|segmentation fault|critical|data loss/i.test(l))) return 'critical'
  if (s.nonZeroExits.length > 0 && s.recoveryPhrases.length > 0) return 'high'
  if (s.errorLines.length > 0 && s.recoveryPhrases.length > 0) return 'medium'
  if (s.nonZeroExits.length > 0 || s.errorLines.length > 1) return 'medium'
  return 'low'
}

function pickVerifiedCommand(s) {
  if (s.retriedCommands.length > 0) return s.retriedCommands[s.retriedCommands.length - 1]
  if (s.commandLines.length > 0) return s.commandLines[s.commandLines.length - 1]
  return undefined
}

function buildDeadEnds(s) {
  const deadEnds = []
  const firstError = s.errorLines[0]
  for (const cmd of s.retriedCommands) {
    deadEnds.push({ tried: cmd, whyFailed: firstError ?? 'retried without success before the working fix' })
  }
  for (const phrase of s.recoveryPhrases) {
    if (/that did(?:n't| not) work|red herring|I was wrong/i.test(phrase)) {
      deadEnds.push({ tried: phrase, whyFailed: 'confident-wrong turn (self-corrected later)' })
    }
  }
  return deadEnds
}

function clamp(str, max) {
  return str.length <= max ? str : str.slice(0, max) + '… [truncated]'
}

function extractCandidates(log, opts = {}) {
  const s = detectFailureSignals(log)
  if (!s.hasSignal) return []
  const maxEvidence = opts.maxEvidenceChars ?? 4000
  const symptom =
    s.errorLines[0] ??
    (s.nonZeroExits.length ? `command exited non-zero (code ${s.nonZeroExits[0]})` : 'agent hit a non-trivial wall during the session')
  const cause =
    s.recoveryPhrases.find((p) => /actually|the (?:real|actual)|turns out|root cause/i.test(p)) ??
    'root cause not explicitly stated in the transcript — see rawEvidence'
  const fix =
    s.fixLines[0] ?? (pickVerifiedCommand(s) ? `applied: ${pickVerifiedCommand(s)}` : 'recovered — see rawEvidence')
  const diagnosticSteps = [...new Set([...s.errorLines.slice(0, 3), ...s.recoveryPhrases.slice(0, 3)])]

  return [
    {
      source: 'testing-loop',
      originAgentId: opts.originAgentId,
      symptom,
      cause,
      diagnosticSteps,
      fix,
      severity: severityFor(s),
      verifiedCommand: pickVerifiedCommand(s),
      deadEnds: buildDeadEnds(s),
      reproduction: {
        host: opts.host,
        steps: s.commandLines.slice(0, 10),
        observedExit: s.nonZeroExits[0],
        reproducedOnRealInfra: true,
      },
      rawEvidence: clamp(log, maxEvidence),
      status: 'new',
    },
  ]
}

// --- transcript reading -----------------------------------------------------

// Flatten a Claude Code JSONL transcript into a plain-text log: assistant text
// blocks + tool inputs (commands) + tool results (command output / errors).
function transcriptToLog(jsonl) {
  const out = []
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const content = obj?.message?.content
    if (typeof content === 'string') {
      out.push(content)
    } else if (Array.isArray(content)) {
      for (const blk of content) {
        if (!blk || typeof blk !== 'object') continue
        if (blk.type === 'text' && blk.text) out.push(blk.text)
        else if (blk.type === 'tool_use' && blk.input?.command) out.push('$ ' + blk.input.command)
        else if (blk.type === 'tool_result') {
          const c = blk.content
          if (typeof c === 'string') out.push(c)
          else if (Array.isArray(c)) for (const r of c) if (r?.type === 'text' && r.text) out.push(r.text)
        }
      }
    }
  }
  return out.join('\n')
}

async function postCandidate(candidate) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
  try {
    await fetch(`${BOARD_URL}/agent-candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(candidate),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  if (!CAPTURE_ENABLED) return
  const raw = await readStdin()
  let payload = {}
  try {
    payload = JSON.parse(raw)
  } catch {
    // Not a JSON Stop-hook payload — nothing to do.
    return
  }
  const transcriptPath = payload.transcript_path || payload.transcriptPath
  if (!transcriptPath) return

  let jsonl = ''
  try {
    jsonl = readFileSync(transcriptPath, 'utf8')
  } catch {
    return
  }

  const log = transcriptToLog(jsonl)
  const sessionId = (payload.session_id || payload.sessionId || randomUUID()).toString().slice(0, 8)
  const candidates = extractCandidates(log, {
    originAgentId: `local-claude-${sessionId}`,
    host: payload.cwd,
  })
  if (candidates.length === 0) return // prefilter suppressed cost — no network

  await Promise.allSettled(candidates.map(postCandidate))
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
