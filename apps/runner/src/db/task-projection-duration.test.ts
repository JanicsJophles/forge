import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { test } from 'node:test'

import { readTaskProjection } from './task-projection.js'

function freshDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE tasks (
    id TEXT, status TEXT, created_at TEXT, started_at TEXT, completed_at TEXT,
    commit_sha TEXT, error_message TEXT, repo TEXT, branch TEXT, prompt TEXT, log TEXT,
    provider TEXT, auto_commit INTEGER
  )`)
  return db
}

function insert(db: Database.Database, id: string, startedAt: string | null, completedAt: string | null) {
  db.prepare(`INSERT INTO tasks (id, status, created_at, started_at, completed_at, repo, branch, prompt, log)
    VALUES (?, 'x', datetime('now'), ?, ?, '/throwaway/repo', 'test', 'prompt', '')`)
    .run(id, startedAt, completedAt)
}

for (const view of ['status', 'detail'] as const) {
  test(`durationMs reflects elapsed run time in the ${view} projection`, () => {
    const db = freshDb()
    try {
      // Finished task: completed_at - started_at, measured in ms.
      insert(db, 'done', '2026-11-06 00:00:00', '2026-11-06 00:12:00')
      // Running task: started 90s ago but not completed -> now - started_at (> 0).
      insert(db, 'running', null, null)
      db.prepare("UPDATE tasks SET started_at = datetime('now', '-90 seconds') WHERE id = 'running'").run()
      // Queued task: no started_at -> null.
      insert(db, 'queued', null, null)

      const done = readTaskProjection(db, 'done', view)!
      assert.equal(done.durationMs, 12 * 60 * 1000)

      const running = readTaskProjection(db, 'running', view)!
      assert.equal(typeof running.durationMs, 'number')
      assert.ok((running.durationMs as number) > 0)

      const queued = readTaskProjection(db, 'queued', view)!
      assert.equal(queued.durationMs, null)
    } finally {
      db.close()
    }
  })
}

test('durationMs clamps to 0 when completed_at precedes started_at', () => {
  const db = freshDb()
  try {
    insert(db, 'skew', '2026-11-06 00:12:00', '2026-11-06 00:00:00')
    const result = readTaskProjection(db, 'skew', 'status')!
    assert.equal(result.durationMs, 0)
  } finally {
    db.close()
  }
})
