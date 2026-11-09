import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { LOG_TAIL_BYTES, readTaskProjection } from './task-projection.js'

test('history and detail decode actual SQLite suffixes for empty and populated logs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-empty-log-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('./schema.js')
  const { listTasks, LIST_LOG_TAIL_BYTES } = await import('./queries.js')
  try {
    const insert = db.prepare(`INSERT INTO tasks
      (id, repo, branch, prompt, status, log, created_at)
      VALUES (?, '/throwaway/repo', 'test', 'test prompt', 'queued', ?, '2026-11-05 12:00:00')`)
    const logs = new Map<string, string | null>([
      ['empty', ''],
      ['legacy-null', null],
      ['ascii', 'hello world'],
      // Each suffix begins at the second byte of the euro sign.
      ['list-unicode', 'prefix€' + 'x'.repeat(LIST_LOG_TAIL_BYTES - 2)],
      ['detail-unicode', 'prefix€' + 'y'.repeat(LOG_TAIL_BYTES - 2)],
    ])
    for (const [id, log] of logs) insert.run(id, log)

    const history = listTasks()
    assert.equal(history.length, logs.size)
    for (const [id, log] of logs) {
      const bytes = Buffer.from(log ?? '')
      const listed = history.find(task => task.id === id)!
      assert.ok(listed)
      assert.equal(listed.logBytes, bytes.length)
      assert.equal(listed.logTruncated, bytes.length > LIST_LOG_TAIL_BYTES)
      assert.equal(listed.status, 'queued')
      assert.equal(listed.repo, '/throwaway/repo')

      for (const limit of [LIST_LOG_TAIL_BYTES, LOG_TAIL_BYTES]) {
        const sql = db.prepare(`SELECT substr(CAST(COALESCE(log, '') AS BLOB), -${limit}) AS tail
          FROM tasks WHERE id = ?`).get(id) as { tail: Buffer | null }
        let expected = log ?? ''
        if (bytes.length === 0) {
          // Assert the driver's real NULL result, not a synthesized empty Buffer.
          assert.equal(sql.tail, null)
        } else {
          assert.ok(Buffer.isBuffer(sql.tail))
          assert.deepEqual(sql.tail, bytes.subarray(-limit))
          if (bytes.length > limit) {
            const split = (id === 'list-unicode' && limit === LIST_LOG_TAIL_BYTES)
              || (id === 'detail-unicode' && limit === LOG_TAIL_BYTES)
            if (split) assert.equal(sql.tail[0] & 0xc0, 0x80)
            expected = (id === 'list-unicode' ? 'x' : 'y').repeat(limit - (split ? 2 : 0))
          }
        }
        if (limit === LIST_LOG_TAIL_BYTES) {
          assert.equal(listed.log, expected)
        } else {
          const detail = readTaskProjection(db, id, 'detail')!
          assert.equal(detail.log, expected)
          assert.equal(detail.logTruncated, bytes.length > limit)
          assert.equal(detail.read_projection_version, 1)
          assert.equal(detail.prompt, 'test prompt')
          assert.equal('log_tail' in detail, false)
        }
      }
      const status = readTaskProjection(db, id, 'status')!
      assert.equal('log' in status, false)
      assert.equal('logTruncated' in status, false)
    }
  } finally {
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    rmSync(directory, { recursive: true, force: true })
  }
})
