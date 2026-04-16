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

console.log(`[db] SQLite open: ${DB_PATH}`)
