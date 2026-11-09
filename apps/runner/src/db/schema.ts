import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { pruneOldTasks, retentionDaysFromEnv } from './retention.js'

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const DB_PATH = path.join(DATA_DIR, 'forge.db')

export const db = new Database(DB_PATH)

// WAL mode: concurrent reads don't block writes
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    repo         TEXT NOT NULL,
    branch       TEXT NOT NULL,
    prompt       TEXT NOT NULL,
    status       TEXT DEFAULT 'queued',
    log          TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now')),
    started_at   TEXT,
    completed_at TEXT,
    error_message TEXT,
    commit_sha   TEXT
  );
`)

// Reconcile any tasks that were 'running' at the last shutdown — those
// are zombies whose agent processes died with the runner (pm2 restart,
// crash, OS kill). Without this they sit 'running' forever and block
// future dispatches that respect same-repo serialization.
db.prepare(
  `UPDATE tasks
   SET status = 'failed',
       error_message = COALESCE(error_message, 'agent process killed by runner restart'),
       completed_at = datetime('now')
   WHERE status IN ('queued', 'running')`
).run()

const columns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
if (!columns.some(c => c.name === 'provider')) {
  db.exec("ALTER TABLE tasks ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'")
}
if (!columns.some(c => c.name === 'auto_commit')) {
  db.exec('ALTER TABLE tasks ADD COLUMN auto_commit INTEGER')
}
if (!columns.some(c => c.name === 'model')) {
  db.exec('ALTER TABLE tasks ADD COLUMN model TEXT')
}

// Ascending expression indexes include rowid as the implicit final key, so
// reverse scans satisfy julianday(created_at) DESC, rowid DESC without sorting.
// The partial index keeps the exact live-task predicate in chronological order.
// The partial index also serves countActiveTasks(). Remove the old status-only
// index: SQLite otherwise prefers its IN lookup plus a temporary chronological
// sort over scanning the already ordered live subset (without ANALYZE stats).
db.exec(`
  CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks(created_at DESC);
  CREATE INDEX IF NOT EXISTS tasks_chronological_idx ON tasks(julianday(created_at));
  CREATE INDEX IF NOT EXISTS tasks_live_chronological_idx ON tasks(julianday(created_at))
    WHERE status IN ('queued', 'running');
  DROP INDEX IF EXISTS tasks_status_idx;
`)

// Prune aged terminal tasks once at boot so forge.db (and its WAL) cannot grow
// without bound on the long-running host and starve the disk guard. Disabled
// (retentionDays === 0) is a no-op. Read from env directly rather than config
// so this stays importable in db-only tests (config.ts exits when the repo
// allowlist is unset); config.retentionDays resolves to the same value.
const retentionDays = retentionDaysFromEnv()
if (retentionDays > 0) {
  const pruned = pruneOldTasks(db, retentionDays)
  console.log(`[db] Retention: pruned ${pruned} task(s) older than ${retentionDays}d`)
}

console.log(`[db] SQLite open: ${DB_PATH}`)
