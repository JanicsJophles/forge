import { execFileSync, spawn } from 'node:child_process'
import { accessSync, constants as FS } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider } from '@forge/shared'
import { SAFE_PATH } from './git-safe.js'

// The fixed directories a read-only run may resolve executables from. NEVER the
// inherited PATH, which (under pm2/root) can point under /root or at shims.
const SAFE_PATH_DIRS = SAFE_PATH.split(':')

// Resolve a bare command name to an absolute path on the fixed PATH that is
// executable. Throws if it is not found — read-only then fails closed rather than
// relying on an attacker-influenceable PATH lookup.
export function resolveExecutable(name: string): string {
  for (const dir of SAFE_PATH_DIRS) {
    const candidate = join(dir, name)
    try {
      accessSync(candidate, FS.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  throw new Error(`executable '${name}' not found on the fixed read-only PATH`)
}

// Read-only Claude is restricted to an explicit allowlist of read-only tools.
// This is defense-in-depth ONLY — the real guarantee is that the agent runs in a
// disposable clone owned by an unprivileged, credential-less account, so even if a
// tool rule were bypassed the agent cannot reach the real repo or any remote.
const READONLY_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  // `rg` is intentionally OMITTED (finding I): `rg --pre <prog>` executes an arbitrary
  // program per file, turning a "search" tool into code execution. Read/Grep/Glob —
  // and git's own grep via the allowed subcommands — cover searching without that hole.
].join(' ')

// Git subcommands are omitted: options such as --output can write files, and
// prefix permission rules cannot safely constrain every argument position.
const READONLY_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit'].join(',')

export function providerCommand(
  provider: AgentProvider,
  readOnly = false,
): { command: string; args: string[] } {
  switch (provider) {
    case 'claude':
      // Read-only hardening (the disposable copy + isolated account is the real
      // guarantee; these flags narrow what the agent can even attempt):
      //   --setting-sources ""   ignore user/project/local settings.json, so a
      //                          repo .claude/settings.json cannot re-enable tools
      //   --strict-mcp-config    only MCP servers from --mcp-config (none given),
      //                          so repo .mcp.json servers never load
      //   --allowedTools         an allowlist of read-only tools (Bash otherwise
      //                          denied by the allowlist)
      //   --disallowedTools      belt-and-suspenders deny of mutation tools
      //   --permission-mode plan no edits/writes/mutating bash in plan mode
      // Drop --dangerously-skip-permissions entirely so no bypass remains.
      return readOnly
        ? {
            command: 'claude',
            args: [
              '--setting-sources', '',
              '--strict-mcp-config',
              '--allowedTools', READONLY_ALLOWED_TOOLS,
              '--disallowedTools', READONLY_DISALLOWED_TOOLS,
              '--permission-mode', 'plan',
              '-p',
            ],
          }
        : { command: 'claude', args: ['--dangerously-skip-permissions', '-p'] }
    // Stdin keeps user prompts out of argv. Codex's own sandbox (bubblewrap) cannot create its mount namespace in
    // the runner's unprivileged LXC ("bwrap: Failed to make / slave: Permission denied"), so every shell command
    // failed while the task still reported success. Like Claude above, Codex relies on the container and the
    // non-root run user (executionIdentity refuses uid 0) as its sandbox.
    //
    // Read-only note: codex --sandbox read-only ALSO shells out to bubblewrap and fails the same way here, so it
    // cannot be used to enforce read-only. The command is therefore identical in both modes; read-only is enforced
    // entirely out-of-band: the agent runs in a disposable clone (no remotes) owned by a credential-less account,
    // so nothing it does can touch the real repo or push anywhere.
    case 'codex': return { command: 'codex', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '-'] }
    default: throw new Error('Unsupported agent provider')
  }
}

// Build a MINIMAL environment for a read-only agent from an explicit allowlist.
// Critically this is NOT derived from process.env, so GH_TOKEN / GITHUB_TOKEN /
// ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / OPENAI_API_KEY and every other
// inherited secret are absent — the agent cannot authenticate to GitHub or any
// remote even if it tries. The provider finds its own auth under the read-only
// account's HOME (or an explicitly configured auth dir).
export function readOnlyEnv(
  home: string,
  username: string,
  provider: AgentProvider,
  opts: { claudeConfigDir?: string; codexHome?: string } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Fixed PATH, never inherited: the parent's PATH (pm2/root) can point under /root
    // or at shims the read-only account should not resolve.
    PATH: SAFE_PATH,
    HOME: home,
    USER: username,
    LOGNAME: username,
  }
  // Locale/terminal are harmless and avoid noisy CLI warnings.
  if (process.env.LANG) env.LANG = process.env.LANG
  if (process.env.TERM) env.TERM = process.env.TERM
  // The provider's OWN auth file location (opt-in override). Never a token value.
  if (provider === 'claude' && opts.claudeConfigDir) env.CLAUDE_CONFIG_DIR = opts.claudeConfigDir
  if (provider === 'codex' && opts.codexHome) env.CODEX_HOME = opts.codexHome
  return env
}

export interface ExecutionIdentity {
  uid: number
  gid: number
  home: string
  username: string
  env: NodeJS.ProcessEnv
}

export function executionIdentity(username: string): ExecutionIdentity {
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
  return { uid, gid, home, username, env }
}

export function checkCodexLogin(options: { uid: number; gid: number; env: NodeJS.ProcessEnv }): Promise<void> {
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
