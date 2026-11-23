import 'dotenv/config'

const rawPaths = process.env.ALLOWED_REPO_PATHS ?? ''
if (!rawPaths.trim()) {
  console.error('[config] FATAL: ALLOWED_REPO_PATHS is not set. Refusing to start.')
  process.exit(1)
}

// Largest value setTimeout accepts; a delay above this overflows to ~1ms and would
// fire almost immediately (finding J: TASK_TIMEOUT_MS>2^31 killed everything at once).
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/**
 * Parse a millisecond duration from the environment, failing SAFE rather than
 * turning a typo into an instant task-killing timeout (finding J).
 *   - unset / empty            → `fallback`
 *   - 0 (or a negative number) → 0, meaning "disabled" (no timeout armed)
 *   - NaN / non-numeric        → `fallback`, with a warning
 *   - > 2^31-1                 → clamped to 2^31-1 (so setTimeout never overflows)
 */
export function parseTimeoutMs(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    console.warn(`[config] ${label}='${raw}' is not a number — using default ${fallback}ms`)
    return fallback
  }
  if (n <= 0) return 0 // disabled
  if (n < 1) return fallback
  return Math.min(Math.floor(n), MAX_TIMEOUT_MS)
}

export const config = {
  port: parseInt(process.env.PORT ?? '5000', 10),
  host: process.env.HOST ?? '0.0.0.0',
  maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT_TASKS ?? '2', 10),
  allowedRepoPaths: rawPaths.split(',').map(p => p.trim()).filter(Boolean),
  autoCommit: process.env.AUTO_COMMIT !== 'false',
  commitMessagePrefix: process.env.COMMIT_MESSAGE_PREFIX ?? '[forge]',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Wall-clock cap on a single READ-ONLY task. On expiry the agent's whole cgroup /
  // process group gets SIGTERM, then SIGKILL after killGraceMs. Default 60 min. 0
  // disables it. Writable tasks are NEVER wall-clock-capped (finding J) — their
  // behaviour is exactly as it was before the read-only work.
  taskTimeoutMs: parseTimeoutMs(process.env.TASK_TIMEOUT_MS, 3_600_000, 'TASK_TIMEOUT_MS'),
  // How long read-only copy preparation may run before the prep worker is torn down.
  readonlyPrepTimeoutMs: parseTimeoutMs(process.env.READONLY_PREP_TIMEOUT_MS, 120_000, 'READONLY_PREP_TIMEOUT_MS'),
  // Grace period between SIGTERM and SIGKILL when terminating a task (timeout/cancel).
  killGraceMs: parseTimeoutMs(process.env.KILL_GRACE_MS, 10_000, 'KILL_GRACE_MS'),
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
  // Root-owned, mode-0711 base directory that holds every disposable read-only copy.
  // NEVER /tmp (finding D): a world-writable /tmp lets another local user pre-create
  // or race the task dirs. The runner creates it 0711 root:root at startup; each task
  // gets a mkdtemp subdir chowned to the read-only account.
  readonlyBaseDir: process.env.READONLY_BASE_DIR?.trim() || '/var/lib/forge/ro',
} as const

export function isRepoAllowed(repo: string): boolean {
  return config.allowedRepoPaths.some(allowed => repo.startsWith(allowed))
}
