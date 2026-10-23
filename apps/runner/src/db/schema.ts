import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

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
// JSON snapshot of what the task changed in its repo (see agent/changes.ts).
if (!columns.some(c => c.name === 'changes')) {
  db.exec('ALTER TABLE tasks ADD COLUMN changes TEXT')
}
console.log(`[db] SQLite open: ${DB_PATH}`)
