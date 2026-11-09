import type Database from 'better-sqlite3'

// Retention is opt-in: TASK_RETENTION_DAYS unset or 0 disables pruning (returns
// 0). Any other value must be a positive integer number of days; an invalid
// value warns and disables, matching how the other *_env helpers in config.ts
// warn-and-default. Lives here (not config.ts) so schema.ts can read it without
// importing config.ts — whose module-level ALLOWED_REPO_PATHS check calls
// process.exit, which the db-only tests must not trigger.
export function retentionDaysFromEnv(): number {
  const raw = process.env.TASK_RETENTION_DAYS
  if (raw === undefined || raw === '0') return 0
  const parsed = Number(raw)
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    console.warn('[config] Invalid TASK_RETENTION_DAYS; disabling task retention pruning.')
    return 0
  }
  return parsed
}

// Delete terminal tasks (completed/failed) whose completed_at is strictly older
// than `days` days. Queued and running tasks have no completed_at and are never
// matched, so live work is always retained. Returns the number of rows removed.
//
// days <= 0 (or non-integer) is a no-op returning 0: retention is opt-in and a
// disabled retention must never delete anything. The comparison uses julianday
// so it matches however completed_at was stored (datetime('now') text, with or
// without a timezone/fractional component).
export function pruneOldTasks(db: Database.Database, days: number): number {
  if (!Number.isInteger(days) || days <= 0) return 0
  const result = db
    .prepare(
      `DELETE FROM tasks
       WHERE status IN ('completed', 'failed')
         AND completed_at IS NOT NULL
         AND julianday('now') - julianday(completed_at) > ?`,
    )
    .run(days)
  return result.changes
}

// Run at startup and every 24 hours while enabled. DELETE makes SQLite pages
// reusable; it does not shrink the database file (no automatic VACUUM).
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000

export function startTaskRetention(
  db: Database.Database,
  days: number,
  schedule: typeof setInterval = setInterval,
): (() => void) | undefined {
  if (!Number.isInteger(days) || days <= 0) return undefined
  const prune = () => {
    try {
      const removed = pruneOldTasks(db, days)
      console.log(`[db] Retention: pruned ${removed} task(s) older than ${days}d`)
    } catch {
      // SQLite errors may contain task data; never log the error itself.
      console.warn('[db] Task retention pruning failed; will retry at the next interval.')
    }
  }
  prune()
  const timer = schedule(prune, RETENTION_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
