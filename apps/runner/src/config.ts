import 'dotenv/config'
import path from 'node:path'

const rawPaths = process.env.ALLOWED_REPO_PATHS ?? ''
if (!rawPaths.trim()) {
  console.error('[config] FATAL: ALLOWED_REPO_PATHS is not set. Refusing to start.')
  process.exit(1)
}

export const config = {
  port: parseInt(process.env.PORT ?? '5000', 10),
  host: process.env.HOST ?? '0.0.0.0',
  maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT_TASKS ?? '2', 10),
  minFreeDiskMb: parseInt(process.env.MIN_FREE_DISK_MB ?? '2048', 10),
  allowedRepoPaths: rawPaths
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => path.resolve(p)),
  // Opt-in: off unless AUTO_COMMIT is explicitly 'true' or '1'. A per-task
  // autoCommit:true in the POST body still overrides this (see runner.ts).
  autoCommit: process.env.AUTO_COMMIT === 'true' || process.env.AUTO_COMMIT === '1',
  commitMessagePrefix: process.env.COMMIT_MESSAGE_PREFIX ?? '[forge]',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Non-root user to run claude as (required: --dangerously-skip-permissions is blocked for root)
  claudeRunUser: process.env.CLAUDE_RUN_USER ?? 'forge',
  codexRunUser: process.env.CODEX_RUN_USER ?? 'forge',
} as const

export function isRepoAllowed(repo: string): boolean {
  if (typeof repo !== 'string' || !repo.trim()) return false
  // Resolve the candidate so traversal segments (../) and relative paths are
  // collapsed before comparison — startsWith on an unnormalized path would let
  // /opt/repos/a/../../etc slip through.
  const candidate = path.resolve(repo)
  return config.allowedRepoPaths.some(
    allowed =>
      // Exact match, or genuinely contained under the root with a separator
      // boundary. The boundary check stops /opt/repos matching /opt/repos-evil.
      candidate === allowed || candidate.startsWith(allowed + path.sep),
  )
}
