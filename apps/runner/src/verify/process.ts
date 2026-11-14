import { spawn } from 'node:child_process'

export interface Identity { uid?: number; gid?: number; env?: NodeJS.ProcessEnv }
export function stopGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal) } catch { /* process already exited */ }
}
export function command(repo: string, cmd: string, args: string[], identity: Identity = {}, timeout = 30_000, outputLimit = 16_384): Promise<{exit: number; tail: string}> {
  return new Promise(resolve => {
    const proc = spawn(cmd, args, { cwd: repo, ...identity, detached: true })
    let tail = ''
    let timedOut = false
    let overflow = false
    let kill: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      if (proc.pid) stopGroup(proc.pid, 'SIGTERM')
      kill = setTimeout(() => { if (proc.pid) stopGroup(proc.pid, 'SIGKILL') }, 1000)
    }, timeout)
    const capture = (data: Buffer) => {
      overflow ||= tail.length + data.length > outputLimit
      tail = (tail + data.toString()).slice(-outputLimit)
    }
    proc.stdout.on('data', capture)
    proc.stderr.on('data', capture)
    proc.on('error', err => { tail = err.message })
    proc.on('close', code => {
      clearTimeout(timer)
      if (kill) clearTimeout(kill)
      // Also stop descendants which inherited pipes or outlived the command.
      if (proc.pid) stopGroup(proc.pid, 'SIGKILL')
      resolve({ exit: timedOut ? 124 : (overflow && outputLimit > 16_384) ? 125 : code ?? 1, tail })
    })
  })
}
