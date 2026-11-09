import { execFileSync, spawn } from 'node:child_process'
import { userInfo } from 'node:os'
import type { AgentProvider } from '@forge/shared'

export function providerCommand(provider: AgentProvider, model?: string): { command: string; args: string[] } {
  switch (provider) {
    // The model flag is a separate argv token (never a shell string) and only
    // appears when a model is supplied; omitting it preserves the default args.
    case 'claude': return {
      command: 'claude',
      args: ['--dangerously-skip-permissions', ...(model ? ['--model', model] : []), '-p'],
    }
    // Stdin keeps user prompts out of argv; workspace-write preserves the sandbox.
    case 'codex': return {
      command: 'codex',
      args: ['exec', '--sandbox', 'workspace-write', ...(model ? ['-m', model] : []), '-'],
    }
    default: throw new Error('Unsupported agent provider')
  }
}

export function executionIdentity(username: string) {
  const current = userInfo()
  let uid = current.uid, gid = current.gid, home = current.homedir
  if (username !== current.username) {
    const fields = execFileSync('getent', ['passwd', username], { encoding: 'utf8', timeout: 5000 }).trim().split(':')
    uid = Number(fields[2]); gid = Number(fields[3]); home = fields[5]
    if (fields[0] !== username || !Number.isInteger(uid) || !Number.isInteger(gid) || !home?.startsWith('/')) {
      throw new Error('Invalid runner account')
    }
  }
  if (uid === 0) throw new Error('Agent runner must use a non-root account')
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USER: username, LOGNAME: username }
  // Never pass runner mutation credentials or borrow service/root provider credentials.
  for (const key of ['FORGE_AUTH_TOKEN', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key]
  return { uid, gid, env }
}

interface LoginProbeDependencies {
  spawn: typeof spawn
  setTimeout: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

export function checkCodexLogin(
  options: ReturnType<typeof executionIdentity>,
  dependencies: LoginProbeDependencies = { spawn, setTimeout, clearTimeout },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer !== undefined) dependencies.clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    // Branch only on the Node error code so no raw diagnostics (argv, path,
    // message) can leak; ENOENT means the codex binary is not on the runner's PATH.
    const spawnFailed = (error?: unknown) => {
      const notFound = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
      finish(new Error(notFound
        ? 'Codex CLI was not found on PATH for the configured runner user'
        : 'Codex CLI is unavailable for the configured runner account'))
    }
    let proc: ReturnType<typeof spawn>
    try {
      proc = dependencies.spawn('codex', ['login', 'status'], { ...options, stdio: 'ignore' })
    } catch (error) {
      spawnFailed(error)
      return
    }
    proc.once('error', spawnFailed)
    proc.once('close', (code, signal) => {
      if (signal) {
        // Only expose signal identifiers, never arbitrary child diagnostics.
        const safeSignal = /^SIG[A-Z0-9]+$/.test(signal) ? signal : 'unknown'
        finish(new Error(`Codex login probe failed (signal ${safeSignal})`))
      } else if (code === 0) finish()
      // Codex uses exit 1 for both missing auth and probe/configuration errors.
      // Without a distinct unauthenticated status, do not claim credentials are missing.
      else {
        const safeCode = Number.isInteger(code) ? String(code) : 'unknown'
        finish(new Error(`Codex login probe failed (exit code ${safeCode})`))
      }
    })
    timer = dependencies.setTimeout(() => {
      if (settled) return
      finish(new Error('Codex login check timed out'))
      proc.kill('SIGKILL')
    }, 10_000)
  })
}
