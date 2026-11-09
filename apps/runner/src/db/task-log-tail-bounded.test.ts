import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { MAX_LOG_SLICE_BYTES, readTaskLog, readTaskLogTail } from './task-log.js'

test('line tails preserve byte offsets and cap backward BLOB reads', () => {
  const queries: string[] = []
  const db = new Database(':memory:', { verbose: sql => queries.push(sql) })
  try {
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, log TEXT)')
    const insert = db.prepare('INSERT INTO tasks VALUES (?, ?)')
    const fixtures: [string, string | null, number, Buffer][] = [
      ['trailing', 'first\nlast\n', 1, Buffer.from('last\n')],
      ['unterminated', 'first\nlast', 1, Buffer.from('last')],
      ['nul-utf8', '前\n\0café🙂\n', 1, Buffer.from('\0café🙂\n')],
      ['blank', 'first\n\n', 1, Buffer.from('\n')],
      ['empty', '', 9, Buffer.alloc(0)],
      ['null', null, 9, Buffer.alloc(0)],
      ['short', 'a\nb\n', 99, Buffer.from('a\nb\n')],
      ['many', 'a\n'.repeat(200000), 20000, Buffer.from('a\n'.repeat(20000))],
      ['many-capped', 'a\n'.repeat(200000), 200000, Buffer.from('a\n'.repeat(MAX_LOG_SLICE_BYTES / 2))],
      ['large-prefix', 'x'.repeat(3 * 1024 * 1024) + '\nlast\n', 1, Buffer.from('last\n')],
      ['split-utf8', '🙂'.repeat(100000) + 'x', 1,
        Buffer.from('🙂'.repeat(100000) + 'x').subarray(-MAX_LOG_SLICE_BYTES)],
      ['huge', '🙂'.repeat(1024 * 1024), 1, Buffer.from('🙂'.repeat(MAX_LOG_SLICE_BYTES / 4))],
      ['huge-trailing', 'x'.repeat(3 * 1024 * 1024) + '\n', 1,
        Buffer.from('x'.repeat(MAX_LOG_SLICE_BYTES - 1) + '\n')],
      // The separator and final newline straddle backward chunk boundaries.
      ['boundary', 'prefix\n' + 'x'.repeat(16383) + '\n', 1, Buffer.from('x'.repeat(16383) + '\n')],
    ]
    for (const [id, log, lines, expected] of fixtures) {
      insert.run(id, log)
      queries.length = 0
      const result = readTaskLogTail(db, id, lines)!
      const totalBytes = Buffer.byteLength(log ?? '')
      assert.deepEqual(result, {
        bytes: expected, offset: totalBytes - expected.length, nextOffset: totalBytes, totalBytes,
      }, id)
      const reads = queries.filter(sql => sql.startsWith('SELECT'))
      assert.ok(reads.every(sql => /SELECT (length|substr)\(/.test(sql)), id)
      const slices = reads.filter(sql => sql.startsWith('SELECT substr'))
      assert.ok(slices.length <= MAX_LOG_SLICE_BYTES / 16384, id)
      for (const sql of slices) {
        const length = sql.match(/, ([0-9.]+)\) AS bytes/)
        assert.ok(length && Number(length[1]) > 0 && Number(length[1]) <= 16384, id)
      }
      // The existing byte-slice API still returns the exact requested bytes,
      // including partial UTF-8 and embedded NULs.
      const full = Buffer.from(log ?? '')
      const bytes = full.subarray(1, 8)
      assert.deepEqual(readTaskLog(db, id, 1, 7), {
        bytes, offset: 1, nextOffset: 1 + bytes.length, totalBytes,
      }, id)
    }
    assert.equal(readTaskLogTail(db, 'missing', 1), undefined)
  } finally {
    db.close()
  }
})
