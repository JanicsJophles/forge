import type { ChildProcess } from 'node:child_process'

export const providerDetached = process.platform === 'linux'

// Only detached Linux providers own a group whose ID is their child PID.
// Missing PIDs (including failed spawns) must never become kill(0) or kill(-1).
// `detached` says whether the child was spawned as a group leader. It defaults
// to the platform rule the runner spawns with, and is a parameter so the PID
// safety rules can be exercised on any platform.
export function hasProcessGroup(proc: ChildProcess, detached: boolean = providerDetached): boolean {
  return detached && Number.isSafeInteger(proc.pid) && proc.pid! > 1 && proc.pid !== process.pid
}

export function signalProvider(
  proc: ChildProcess, signal: NodeJS.Signals,
  send: typeof process.kill = process.kill,
  detached: boolean = providerDetached,
): void {
  if (!hasProcessGroup(proc, detached)) {
    proc.kill(signal)
    return
  }
  try {
    send(-proc.pid!, signal)
  } catch (error) {
    // The entire group may already have exited. Other signal failures are
    // reported through the child's error path without abandoning escalation.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') proc.emit('error', error)
  }
}
