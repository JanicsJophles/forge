import type { ChildProcess } from 'node:child_process'
import type { RunRequest } from '@forge/shared'
import { stopGroup } from './process.js'

export interface Limits { maxWallMinutes: number; maxOutputBytes: number }
export function resolveLimits(request: RunRequest, defaults: Limits, maximum: Limits): Limits {
  const result = { ...defaults }
  for (const key of ['maxWallMinutes', 'maxOutputBytes'] as const) {
    const value = request[key] ?? defaults[key]
    if (!Number.isFinite(value) || value <= 0 || value > maximum[key]) throw new Error(`${key} must be positive and at most ${maximum[key]}`)
    result[key] = value
  }
  return result
}
export function enforceCaps(proc: ChildProcess, limits: Limits, capped: (reason: string) => void) {
  let reason = ''
  let bytes = 0
  let escalation: ReturnType<typeof setTimeout> | undefined
  function stop(message: string) {
    if (reason) return
    reason = message
    capped(message)
    if (proc.pid) stopGroup(proc.pid, 'SIGTERM')
    escalation = setTimeout(() => { if (proc.pid) stopGroup(proc.pid, 'SIGKILL') }, 1000)
  }
  const timer = setTimeout(() => stop(`wall time exceeded ${limits.maxWallMinutes} minutes`), limits.maxWallMinutes * 60_000)
  return {
    consume(data: Buffer): string {
      const available = Math.max(0, limits.maxOutputBytes - bytes)
      bytes += data.length
      if (bytes > limits.maxOutputBytes) stop(`output exceeded ${limits.maxOutputBytes} bytes`)
      return data.subarray(0, available).toString()
    },
    dispose() {
      clearTimeout(timer)
      if (escalation) clearTimeout(escalation)
      if (reason && proc.pid) stopGroup(proc.pid, 'SIGKILL')
    },
  }
}
