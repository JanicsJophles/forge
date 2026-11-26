// Stall detection for agent processes.
//
// The runner only settles a task when the agent process closes. Two ways a task can then sit in `running` forever:
//   1. stalled: the agent stops producing any output (a tool call that never returns, e.g. a hung headless Chrome).
//   2. lingering: Claude already printed its final `result` event, but `claude -p` does not exit while a
//      background shell it started is still alive. On 2026-11-25 two tasks sat 23h this way: each had left an
//      `until <condition>; do sleep 5; done` poll whose condition could never become true (one used
//      `pgrep -f atlas-check.sh`, which matches its own command line).
// The watchdog notices both from output timestamps alone, so it needs no knowledge of what the agent runs.

export type StallKind = 'stalled' | 'lingering'

export interface StallVerdict {
  kind: StallKind
  /** Milliseconds since the last output (stalled) or since the final result (lingering). */
  idleMs: number
  message: string
}

export interface WatchdogLimits {
  /** No output at all for this long means the agent is stuck. */
  stallMs: number
  /** After the final result, the process gets this long to exit on its own. */
  exitGraceMs: number
}

function minutesFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  // 0 or a negative value turns that check off; anything unparsable keeps the default.
  return Number.isFinite(value) ? value : fallback
}

/** Per-task overrides from POST /tasks, in minutes; anything unset falls back to the runner's env defaults. */
export interface WatchdogOverrides {
  stallMinutes?: number
  exitGraceMinutes?: number
}

export const MAX_WATCHDOG_MINUTES = 24 * 60

/** Error text for an invalid override, or null. 0 turns a check off; fractions are allowed. */
export function invalidWatchdogOverride(name: string, value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_WATCHDOG_MINUTES) {
    return `${name} must be a number of minutes from 0 to ${MAX_WATCHDOG_MINUTES}`
  }
  return null
}

export function watchdogLimits(overrides: WatchdogOverrides = {}): WatchdogLimits {
  return {
    stallMs: (overrides.stallMinutes ?? minutesFromEnv('TASK_STALL_MINUTES', 45)) * 60_000,
    exitGraceMs: (overrides.exitGraceMinutes ?? minutesFromEnv('TASK_EXIT_GRACE_MINUTES', 10)) * 60_000,
  }
}

/** How often to check: a quarter of the shortest active limit, between 200 ms and 30 s. */
export function watchdogIntervalMs(limits: WatchdogLimits): number {
  const active = [limits.stallMs, limits.exitGraceMs].filter(ms => ms > 0)
  if (!active.length) return 30_000
  return Math.max(200, Math.min(30_000, Math.floor(Math.min(...active) / 4)))
}

const minutes = (ms: number) => Math.round(ms / 60_000)

export class StallWatchdog {
  private lastOutputAt: number
  private resultAt: number | null = null

  constructor(private readonly limits: WatchdogLimits, now: number = Date.now()) {
    this.lastOutputAt = now
  }

  /** Any stdout or stderr from the agent. */
  output(now: number = Date.now()): void {
    this.lastOutputAt = now
    // Claude can print a result, get re-invoked by a finished background task, and print another one:
    // new output after a result restarts the exit grace from the next result.
    this.resultAt = null
  }

  /** The agent printed its final result event. Call after output() for the same chunk. */
  result(now: number = Date.now()): void {
    this.resultAt = now
  }

  check(now: number = Date.now()): StallVerdict | null {
    if (this.resultAt !== null && this.limits.exitGraceMs > 0) {
      const idleMs = now - this.resultAt
      if (idleMs >= this.limits.exitGraceMs) {
        return {
          kind: 'lingering',
          idleMs,
          message: `agent finished ${minutes(idleMs)} min ago but its process did not exit (a background shell is likely still running)`,
        }
      }
    }
    if (this.limits.stallMs > 0) {
      const idleMs = now - this.lastOutputAt
      if (idleMs >= this.limits.stallMs) {
        return { kind: 'stalled', idleMs, message: `no agent output for ${minutes(idleMs)} min` }
      }
    }
    return null
  }
}
