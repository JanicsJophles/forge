import 'dotenv/config'

const rawPaths = process.env.ALLOWED_REPO_PATHS ?? ''
if (!rawPaths.trim()) {
  console.error('[config] FATAL: ALLOWED_REPO_PATHS is not set. Refusing to start.')
  process.exit(1)
}

export const config = {
  port: parseInt(process.env.PORT ?? '5000', 10),
  host: process.env.HOST ?? '0.0.0.0',
  maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT_TASKS ?? '2', 10),
  allowedRepoPaths: rawPaths.split(',').map(p => p.trim()).filter(Boolean),
  autoCommit: process.env.AUTO_COMMIT !== 'false',
  commitMessagePrefix: process.env.COMMIT_MESSAGE_PREFIX ?? '[forge]',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Non-root user to run claude as (required: --dangerously-skip-permissions is blocked for root)
  claudeRunUser: process.env.CLAUDE_RUN_USER ?? 'forge',
  codexRunUser: process.env.CODEX_RUN_USER ?? 'forge',
  // Dedicated, isolated account used ONLY for read-only tasks. It must own nothing
  // else and carry no ssh keys / gh config / git credentials. Read-only support is
  // advertised (and accepted) only when this is set AND the account resolves to a
  // non-root uid. No default: a missing value disables read-only entirely.
  readonlyRunUser: process.env.READONLY_RUN_USER?.trim() || undefined,
  // Optional explicit auth-location overrides passed to the read-only agent's
  // minimal env allowlist. Leave unset to let the provider read auth from the
  // read-only account's own HOME (~/.claude, ~/.codex).
  readonlyClaudeConfigDir: process.env.READONLY_CLAUDE_CONFIG_DIR?.trim() || undefined,
  readonlyCodexHome: process.env.READONLY_CODEX_HOME?.trim() || undefined,
} as const

export function isRepoAllowed(repo: string): boolean {
  return config.allowedRepoPaths.some(allowed => repo.startsWith(allowed))
}
