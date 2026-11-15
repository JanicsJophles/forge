import 'dotenv/config'

const rawPaths = process.env.ALLOWED_REPO_PATHS ?? ''
if (!rawPaths.trim()) {
  console.error('[config] FATAL: ALLOWED_REPO_PATHS is not set. Refusing to start.')
  process.exit(1)
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`)
  return value
}
const maximum = {
  maxWallMinutes: positiveEnv('MAX_WALL_MINUTES', 60),
  maxOutputBytes: positiveEnv('MAX_OUTPUT_BYTES', 10_485_760),
}
export const config = {
  maximum,
  limits: {
    maxWallMinutes: Math.min(positiveEnv('DEFAULT_WALL_MINUTES', 30), maximum.maxWallMinutes),
    maxOutputBytes: Math.min(positiveEnv('DEFAULT_OUTPUT_BYTES', 5_242_880), maximum.maxOutputBytes),
  },
  verification: {
    requireDraftPR: process.env.REQUIRE_DRAFT_PR === 'true',
    allowNoGate: process.env.ALLOW_NO_GATE === 'true',
    allowTestChanges: process.env.ALLOW_TEST_CHANGES === 'true',
    allowEnvFiles: process.env.ALLOW_ENV_FILES === 'true',
    allowSecrets: process.env.ALLOW_SECRETS === 'true',
    gateTimeoutMs: positiveEnv('GATE_TIMEOUT_MS', 300_000),
    allowWorkflows: process.env.ALLOW_WORKFLOW_EDITS === 'true',
    forbiddenPatterns: JSON.parse(process.env.FORBIDDEN_DIFF_PATTERNS ?? '[]') as string[],
  },
  port: parseInt(process.env.PORT ?? '5000', 10),
  host: process.env.HOST ?? '0.0.0.0',
  maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT_TASKS ?? '2', 10),
  allowedRepoPaths: rawPaths.split(',').map(p => p.trim()).filter(Boolean),
  autoCommit: process.env.AUTO_COMMIT !== 'false',
  commitMessagePrefix: process.env.COMMIT_MESSAGE_PREFIX ?? '[forge]',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Non-root user to run claude as (required: --dangerously-skip-permissions is blocked for root)
  claudeRunUser: process.env.CLAUDE_RUN_USER ?? 'forge',
} as const

export function isRepoAllowed(repo: string): boolean {
  return config.allowedRepoPaths.some(allowed => repo.startsWith(allowed))
}
