import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import Database from 'better-sqlite3'
import { readTaskStreamSnapshot } from '../db/task-stream-snapshot.js'
import { LOG_TAIL_BYTES } from '../db/task-projection.js'
import { streamTask } from './task-stream.js'

const marker = '… [earlier output truncated]\n'
function fixture(t: { after(fn: () => void): void }) {
  const sql: string[] = []
  const db = new Database(':memory:', { verbose: statement => sql.push(statement) })
  t.after(() => db.close())
  db.exec('CREATE TABLE tasks (id TEXT, status TEXT, error_message TEXT, log TEXT, prompt TEXT)')
  const seed = (log: string | null, status = 'running', error: string | null = null) => {
    db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)').run('task', status, error, log, 'P'.repeat(3_000_000))
    sql.length = 0
  }
  return { db, sql, seed }
}
class Socket extends EventEmitter {
  frames: string[] = []
  ended = false
  setHeader() {}
  flushHeaders() {}
  write(frame: string) { this.frames.push(frame); return true }
  end() { this.ended = true }
}

test('SQLite returns only a bounded UTF-8 suffix and metadata in one snapshot', t => {
  const { db, sql, seed } = fixture(t)
  const budget = LOG_TAIL_BYTES - Buffer.byteLength(marker)
  // The suffix begins within the four-byte emoji; drop its continuation bytes.
  seed('HEAD'.repeat(1_000_000) + '😀' + 'z'.repeat(budget - 1))
  const snapshot = readTaskStreamSnapshot(db, 'task')!
  assert.equal(snapshot.log, marker + 'z'.repeat(budget - 1))
  assert.ok(Buffer.byteLength(snapshot.log!) <= LOG_TAIL_BYTES)
  assert.deepEqual(Object.keys(snapshot).sort(), ['errorMessage', 'id', 'log', 'status'])
  assert.equal(sql.length, 1)
  assert.doesNotMatch(sql[0], /prompt|SELECT \*/i)
  assert.match(sql[0], /substr\(CAST\(log AS BLOB\)/)
})

test('no replay selects no log or prompt, including on terminal tasks', t => {
  const { db, sql, seed } = fixture(t)
  seed('L'.repeat(4_000_000), 'failed', 'saved failure')
  const snapshot = readTaskStreamSnapshot(db, 'task', false)!
  assert.equal(snapshot.log, '')
  assert.equal(snapshot.errorMessage, 'saved failure')
  assert.equal(sql.length, 1)
  assert.doesNotMatch(sql[0], /log|prompt/i)
})

test('NULL and short logs, embedded NULs, exact limit, and missing tasks', t => {
  const { db, seed } = fixture(t)
  for (const log of [null, '', 'hello\0😀', 'x'.repeat(LOG_TAIL_BYTES)]) {
    db.exec('DELETE FROM tasks')
    seed(log)
    assert.equal(readTaskStreamSnapshot(db, 'task')!.log, log ?? '')
  }
  assert.equal(readTaskStreamSnapshot(db, 'missing'), undefined)
})

test('snapshot preserves marker, terminal reconnects and live subscriptions', t => {
  const { db, seed } = fixture(t)
  for (const status of ['completed', 'failed', 'running']) {
    db.exec('DELETE FROM tasks')
    seed('x'.repeat(3_000_000), status, 'saved failure')
    const snapshot = readTaskStreamSnapshot(db, 'task')!
    const req = new EventEmitter()
    const res = new Socket()
    const emitter = status === 'running' ? new EventEmitter() : undefined
    streamTask(req as Request, res as unknown as Response, snapshot, emitter)
    const logs = res.frames.filter(f => f.startsWith('event: log\n'))
      .map(f => JSON.parse(f.split('\ndata: ')[1])).join('')
    assert.equal(logs, snapshot.log)
    assert.ok(logs.startsWith(marker))
    if (emitter) {
      emitter.emit('event', { type: 'log', data: 'live' })
      assert.match(res.frames.at(-1)!, /"live"/)
      emitter.emit('done')
      assert.equal(emitter.listenerCount('event'), 0)
    } else {
      assert.match(res.frames.at(-1)!, status === 'failed' ? /event: error\ndata: "saved failure"/ : /event: complete/)
    }
    assert.equal(res.ended, true)
  }
})
