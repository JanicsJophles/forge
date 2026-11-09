import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'
import { pruneOldTasks, retentionDaysFromEnv } from './retention.js'

// A standalone sqlite db mirroring the tasks columns retention touches. Using a
// throwaway db (not schema.ts's singleton) lets each test pin completed_at
// precisely via SQL date modifiers.
const directory = mkdtempSync(join(tmpdir(), 'forge-retention-'))
const db = new Database(join(directory, 'retention.db'))
db.exec(`
  CREATE TABLE tasks (
    id           TEXT PRIMARY KEY,
    repo         TEXT NOT NULL DEFAULT 'forge',
    branch       TEXT NOT NULL DEFAULT 'test',
    prompt       TEXT NOT NULL DEFAULT 'p',
    status       TEXT DEFAULT 'queued',
    completed_at TEXT
  );
`)
const insert = db.prepare(
  "INSERT INTO tasks (id, status, completed_at) VALUES (?, ?, datetime('now', ?))",
)
// An active task has no completed_at; datetime('now', NULL) yields NULL.
const insertActive = db.prepare('INSERT INTO tasks (id, status) VALUES (?, ?)')
const ids = () => (db.prepare('SELECT id FROM tasks ORDER BY id').all() as { id: string }[]).map(r => r.id)

after(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

function seed(): void {
  db.exec('DELETE FROM tasks')
  insert.run('old-completed', 'completed', '-100 days')
  insert.run('old-failed', 'failed', '-100 days')
  insert.run('recent-completed', 'completed', '-1 days')
  insertActive.run('queued-task', 'queued')
  insertActive.run('running-task', 'running')
}

test('pruneOldTasks is a no-op when retention is disabled (0)', () => {
  seed()
  assert.equal(pruneOldTasks(db, 0), 0)
  assert.deepEqual(ids(), ['old-completed', 'old-failed', 'queued-task', 'recent-completed', 'running-task'])
})

test('pruneOldTasks deletes only aged terminal tasks, keeping recent and active ones', () => {
  seed()
  const removed = pruneOldTasks(db, 30)
  assert.equal(removed, 2)
  // Old completed + failed gone; recent terminal and both active tasks retained.
  assert.deepEqual(ids(), ['queued-task', 'recent-completed', 'running-task'])
})

test('pruneOldTasks ignores non-positive / non-integer day counts', () => {
  seed()
  assert.equal(pruneOldTasks(db, -5), 0)
  assert.equal(pruneOldTasks(db, 1.5), 0)
  assert.equal(pruneOldTasks(db, Number.NaN), 0)
  assert.equal(ids().length, 5)
})

test('retentionDaysFromEnv parses, disables, and warns-and-defaults', () => {
  const original = process.env.TASK_RETENTION_DAYS
  const restore = () => {
    if (original === undefined) delete process.env.TASK_RETENTION_DAYS
    else process.env.TASK_RETENTION_DAYS = original
  }
  try {
    delete process.env.TASK_RETENTION_DAYS
    assert.equal(retentionDaysFromEnv(), 0, 'unset disables')
    process.env.TASK_RETENTION_DAYS = '0'
    assert.equal(retentionDaysFromEnv(), 0, '0 disables')
    process.env.TASK_RETENTION_DAYS = '14'
    assert.equal(retentionDaysFromEnv(), 14, 'positive integer parses')

    for (const bad of ['-1', '1.5', 'NaN', 'abc', '7d', ' 7 ']) {
      process.env.TASK_RETENTION_DAYS = bad
      const warnings: string[] = []
      const originalWarn = console.warn
      console.warn = message => warnings.push(String(message))
      try {
        assert.equal(retentionDaysFromEnv(), 0, `${bad} disables`)
      } finally {
        console.warn = originalWarn
      }
      assert.deepEqual(warnings, ['[config] Invalid TASK_RETENTION_DAYS; disabling task retention pruning.'])
    }
  } finally {
    restore()
  }
})
