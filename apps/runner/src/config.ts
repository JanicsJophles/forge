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
  // Bearer token required on state-changing task routes (see auth.ts). Unset = open, with a startup warning.
  runnerToken: process.env.FORGE_RUNNER_TOKEN,
} as const

// Read once, then drop it from the environment: agents (and git hooks in the
// repos they edit) inherit process.env, and their output is readable through
// the open GET /tasks/:id, so the token must not be visible to them.
delete process.env.FORGE_RUNNER_TOKEN

export function isRepoAllowed(repo: string): boolean {
  return config.allowedRepoPaths.some(allowed => repo.startsWith(allowed))
}
