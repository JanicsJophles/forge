import 'dotenv/config'
import { resolveAllowedRepo } from './agent/repo-path.js'
import { TOKEN_ENV, tokensFromEnv } from './routes/auth.js'
import { BOARD_TOKEN_ENV, boardTokensFromEnv } from './routes/board-auth.js'

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
  // Bearer tokens (caller name -> token) required on state-changing task routes; see routes/auth.ts.
  // None set = open, with a startup warning.
  runnerTokens: tokensFromEnv(process.env),
  // Agent-board writer tokens (writer name -> token); see routes/board-auth.ts.
  boardTokens: boardTokensFromEnv(process.env),
} as const

// Read once, then drop them from the environment: agents (and git hooks in the
// repos they edit) inherit process.env, so no token may be visible to them.
for (const key of Object.keys(process.env)) if (TOKEN_ENV.test(key) || BOARD_TOKEN_ENV.test(key)) delete process.env[key]

// A string prefix match let "/opt/repos/../../etc" through to the root runner's chown -R.
export function isRepoAllowed(repo: string): boolean {
  return resolveAllowedRepo(repo, config.allowedRepoPaths) !== null
}
