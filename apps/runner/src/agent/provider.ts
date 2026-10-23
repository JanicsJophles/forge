import { execFileSync, spawn } from 'node:child_process'
import { userInfo } from 'node:os'
import type { AgentProvider } from '@forge/shared'

export function providerCommand(provider: AgentProvider): { command: string; args: string[] } {
  switch (provider) {
    case 'claude': return { command: 'claude', args: ['--dangerously-skip-permissions', '-p'] }
    // Stdin keeps user prompts out of argv; workspace-write preserves the sandbox.
    case 'codex': return { command: 'codex', args: ['exec', '--sandbox', 'workspace-write', '-'] }
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
  // Never borrow the service/root account's credential directory or API keys.
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'FORGE_RUNNER_TOKEN']) delete env[key]
  return { uid, gid, env }
}

export function checkCodexLogin(options: ReturnType<typeof executionIdentity>): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('codex', ['login', 'status'], { ...options, stdio: 'ignore' })
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Codex login check timed out')) }, 10_000)
    proc.once('error', () => { clearTimeout(timer); reject(new Error('Codex CLI is unavailable for the configured runner account')) })
    proc.once('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('Codex is not signed in. Run codex login --device-auth as CODEX_RUN_USER on the runner host.'))
    })
  })
}
