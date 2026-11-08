import 'dotenv/config'
import path from 'node:path'
import { realpathSync } from 'node:fs'

function positiveIntegerEnv(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    console.warn(`[config] Invalid ${name}; using default ${fallback}.`)
    return fallback
  }
  return parsed
}

// Node clamps delays above the signed 32-bit timer limit to 1ms.
function taskTimeoutEnv(): number {
  const raw = process.env.TASK_TIMEOUT_MS
  const fallback = 1800000
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 1 || parsed > 2147483647) {
    console.warn(`[config] Invalid TASK_TIMEOUT_MS; using default ${fallback}.`)
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
  port: positiveIntegerEnv('PORT', 5000, 65535),
  taskTimeoutMs: taskTimeoutEnv(),
  host: process.env.HOST ?? '0.0.0.0',
  maxConcurrentTasks: positiveIntegerEnv('MAX_CONCURRENT_TASKS', 2),
  minFreeDiskMb: positiveIntegerEnv('MIN_FREE_DISK_MB', 2048, Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024))),
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
  // Optional bearer token guarding state-changing routes. Unset or blank means
  // auth is OFF and every route is open, exactly as before (see routes/auth.ts).
  authToken: process.env.FORGE_AUTH_TOKEN?.trim() || undefined,
  // Short git SHA of the deployed build, appended to the reported version when
  // set. Optional: empty/unset means version is the package.json value alone.
  gitSha: process.env.FORGE_GIT_SHA?.trim() || undefined,
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
