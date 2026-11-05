import 'dotenv/config'
import path from 'node:path'
import { realpathSync } from 'node:fs'

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[config] Invalid ${name}; using default ${fallback}.`)
    return fallback
  }
  return parsed
}

const rawPaths = process.env.ALLOWED_REPO_PATHS ?? ''
if (!rawPaths.trim()) {
  console.error('[config] FATAL: ALLOWED_REPO_PATHS is not set. Refusing to start.')
  process.exit(1)
}

export const config = {
  port: positiveIntegerEnv('PORT', 5000),
  host: process.env.HOST ?? '0.0.0.0',
  maxConcurrentTasks: positiveIntegerEnv('MAX_CONCURRENT_TASKS', 2),
  minFreeDiskMb: positiveIntegerEnv('MIN_FREE_DISK_MB', 2048),
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
  let candidate: string
  try {
    candidate = realpathSync(repo)
  } catch {
    return false
  }
  return config.allowedRepoPaths.some(allowed => {
    try {
      // Resolve both sides on each check: configured roots may themselves be
      // symlinks, and a missing or inaccessible root must fail closed.
      const relative = path.relative(realpathSync(allowed), candidate)
      return relative === '' || (
        relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      )
    } catch {
      return false
    }
  })
}
