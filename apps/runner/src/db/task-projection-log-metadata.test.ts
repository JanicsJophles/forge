import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { test } from 'node:test'

import { LOG_TAIL_BYTES, readTaskProjection } from './task-projection.js'

const cases = [
  { name: 'NULL', log: null, offset: 0 },
  { name: 'empty', log: '', offset: 0 },
  { name: 'ASCII', log: 'hello', offset: 0 },
  { name: 'embedded NUL', log: 'before\0after', offset: 0 },
  { name: 'large ASCII', log: 'a'.repeat(LOG_TAIL_BYTES * 8), offset: LOG_TAIL_BYTES * 7 },
  { name: 'large NUL', log: 'a'.repeat(LOG_TAIL_BYTES) + '\0tail', offset: 5 },
  { name: 'whole multibyte', log: '€' + 'a'.repeat(LOG_TAIL_BYTES - 3), offset: 0 },
  ...[1, 2, 3].map(skipped => ({
    name: `multibyte boundary skips ${skipped} bytes`,
    log: 'prefix😀' + 'a'.repeat(LOG_TAIL_BYTES - skipped),
    offset: Buffer.byteLength('prefix😀'),
  })),
]

for (const modern of [true, false]) {
  test(`detail log byte metadata with ${modern ? 'current' : 'legacy'} schema`, () => {
    const statements: string[] = []
    const db = new Database(':memory:', { verbose: sql => statements.push(sql) })
    try {
      db.exec(`CREATE TABLE tasks (
        id TEXT, status TEXT, created_at TEXT, started_at TEXT, completed_at TEXT,
        commit_sha TEXT, error_message TEXT, repo TEXT, branch TEXT, prompt TEXT, log TEXT
        ${modern ? ', provider TEXT, auto_commit INTEGER' : ''}
      )`)
      for (const { name, log, offset } of cases) {
        db.prepare('INSERT INTO tasks (id, log) VALUES (?, ?)').run(name, log)
        statements.length = 0
        const detail = readTaskProjection(db, name, 'detail')!
        const bytes = Buffer.from(log ?? '')
        assert.equal(detail.logBytes, bytes.length, name)
        assert.equal(detail.logTailOffset, offset, name)
        assert.equal(detail.log, bytes.subarray(offset).toString('utf8'), name)
        assert.equal(Buffer.byteLength(detail.log as string) + Number(detail.logTailOffset), detail.logBytes, name)
        assert.equal(detail.log_truncated, bytes.length > LOG_TAIL_BYTES, name)
        assert.equal('log_tail' in detail, false)
        const select = statements.find(sql => sql.startsWith('SELECT'))!
        assert.match(select, /substr\(CAST\(COALESCE\(log, ''\) AS BLOB\), -262144\)/)
        assert.match(select, /length\(CAST\(COALESCE\(log, ''\) AS BLOB\)\) AS logBytes/)
        statements.length = 0
        const status = readTaskProjection(db, name, 'status')!
        for (const field of ['log', 'logBytes', 'logTailOffset', 'log_truncated']) {
          assert.equal(field in status, false)
        }
        assert.doesNotMatch(statements.find(sql => sql.startsWith('SELECT'))!, /\blog\b|logBytes|logTailOffset/i)
      }
    } finally {
      db.close()
    }
  })
}
