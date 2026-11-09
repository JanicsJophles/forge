import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { test } from 'node:test'

import { LOG_TAIL_BYTES, readTaskProjection } from './task-projection.js'

for (const modern of [true, false]) {
  test(`task projections retain saved autoCommit with ${modern ? 'current' : 'legacy'} schema`, () => {
    const statements: string[] = []
    const db = new Database(':memory:', { verbose: sql => statements.push(sql) })
    try {
      db.exec(`CREATE TABLE tasks (
        id TEXT, status TEXT, created_at TEXT, started_at TEXT, completed_at TEXT,
        commit_sha TEXT, error_message TEXT, repo TEXT, branch TEXT, prompt TEXT, log TEXT
        ${modern ? ', provider TEXT, auto_commit INTEGER' : ''}
      )`)
      for (const choice of [1, 0, null]) {
        const id = String(choice)
        db.prepare(`INSERT INTO tasks VALUES (?, 'completed', 'created', 'started', 'completed',
          'sha', NULL, '/throwaway/repo', 'test', 'prompt', ?
          ${modern ? ", 'codex', ?" : ''})`).run(
          id, 'x'.repeat(LOG_TAIL_BYTES + 10), ...(modern ? [choice] : []),
        )
        for (const view of ['status', 'detail'] as const) {
          statements.length = 0
          const result = readTaskProjection(db, id, view)!
          const expected: Record<string, unknown> = {
            id, status: 'completed', createdAt: 'created', startedAt: 'started',
            completedAt: 'completed', commitSha: 'sha', errorMessage: null,
            autoCommit: modern && choice !== null ? Boolean(choice) : undefined,
            // started_at/completed_at are non-datetime literals here, so julianday
            // yields NULL and durationMs comes back null.
            durationMs: null,
            read_projection_version: 1,
          }
          if (modern) expected.provider = 'codex'
          if (view === 'detail') Object.assign(expected, {
            repo: '/throwaway/repo', branch: 'test', prompt: 'prompt',
            log: 'x'.repeat(LOG_TAIL_BYTES), logBytes: LOG_TAIL_BYTES + 10,
            logTailOffset: 10, logTruncated: true,
          })
          assert.deepEqual(result, expected)
          const select = statements.find(sql => sql.startsWith('SELECT'))!
          assert.ok(select)
          if (view === 'status') assert.doesNotMatch(select, /\blog\b/i)
          else assert.match(select, /substr\(CAST\(COALESCE\(log/)
          assert.equal('auto_commit' in result, false)
          if (!modern || choice === null) {
            assert.equal('autoCommit' in JSON.parse(JSON.stringify(result)), false)
          }
        }
      }
      for (const view of ['status', 'detail'] as const) {
        assert.equal(readTaskProjection(db, 'missing', view), undefined)
      }
    } finally {
      db.close()
    }
  })
}
