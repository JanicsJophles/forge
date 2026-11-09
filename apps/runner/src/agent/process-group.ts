import type { ChildProcess } from 'node:child_process'

export const providerDetached = process.platform === 'linux'

// Only detached Linux providers own a group whose ID is their child PID.
// Missing PIDs (including failed spawns) must never become kill(0) or kill(-1).
export function hasProcessGroup(proc: ChildProcess): boolean {
  return providerDetached && Number.isSafeInteger(proc.pid) && proc.pid! > 1 && proc.pid !== process.pid
}

export function signalProvider(
  proc: ChildProcess, signal: NodeJS.Signals,
  send: typeof process.kill = process.kill,
): void {
  if (!hasProcessGroup(proc)) {
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
