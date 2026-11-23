import { execFileSync, spawn } from 'node:child_process'
import { userInfo } from 'node:os'
import type { AgentProvider } from '@forge/shared'

export function providerCommand(
  provider: AgentProvider,
  readOnly = false,
): { command: string; args: string[] } {
  switch (provider) {
    case 'claude':
      // Read-only: plan mode forbids edits / writes / mutating bash, and we also
      // explicitly deny the file-mutation tools. Drop --dangerously-skip-permissions
      // so no permission bypass remains. Writable mode is unchanged.
      return readOnly
        ? { command: 'claude', args: ['--permission-mode', 'plan', '--disallowedTools', 'Edit,Write,NotebookEdit', '-p'] }
        : { command: 'claude', args: ['--dangerously-skip-permissions', '-p'] }
    // Stdin keeps user prompts out of argv. Codex's own sandbox (bubblewrap) cannot create its mount namespace in
    // the runner's unprivileged LXC ("bwrap: Failed to make / slave: Permission denied"), so every shell command
    // failed while the task still reported success. Like Claude above, Codex relies on the container and the
    // non-root run user (executionIdentity refuses uid 0) as its sandbox.
    //
    // Read-only note: codex --sandbox read-only ALSO shells out to bubblewrap and
    // fails the same way here, so it cannot be used to enforce read-only. The command
    // is therefore identical in both modes; read-only is enforced out-of-band by the
    // runner (autoCommit off, push blocked via readOnlyGitEnv, and a post-task
    // dirty-tree check that reverts any change and fails the task).
    case 'codex': return { command: 'codex', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '-'] }
    default: throw new Error('Unsupported agent provider')
  }
}

// Returns a copy of env with git configured to refuse every push: each remote URL
// scheme is rewritten (pushInsteadOf) to a nonexistent local path, so any `git push`
// the agent attempts fails instantly without reaching a real remote. pushInsteadOf
// only affects pushes, so fetch / read operations still work. Used for read-only tasks.
export function readOnlyGitEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blockedBase = 'file:///nonexistent/forge-read-only-no-push/'
  const schemes = ['https://', 'http://', 'ssh://', 'git://', 'git@', 'file://']
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  let count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10)
  if (!Number.isInteger(count) || count < 0) count = 0
  for (const scheme of schemes) {
    env[`GIT_CONFIG_KEY_${count}`] = `url.${blockedBase}.pushInsteadOf`
    env[`GIT_CONFIG_VALUE_${count}`] = scheme
    count++
  }
  env.GIT_CONFIG_COUNT = String(count)
  return env
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
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key]
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
