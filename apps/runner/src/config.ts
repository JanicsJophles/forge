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
  // Stuckpoint capture (RAC-378): where candidates are shipped + master switch.
  // The board is co-located on this same box in prod; localhost default keeps
  // the POST on-loopback. CAPTURE_ENABLED=false fully disables the hook.
  agentBoardUrl: process.env.AGENT_BOARD_URL ?? `http://127.0.0.1:${process.env.PORT ?? '5000'}`,
  captureEnabled: process.env.CAPTURE_ENABLED !== 'false',
} as const

export function isRepoAllowed(repo: string): boolean {
  return config.allowedRepoPaths.some(allowed => repo.startsWith(allowed))
}
