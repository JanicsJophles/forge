import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'

import { decodeTail, readTaskProjection, STATUS_ERROR_BYTES } from './task-projection.js'

test('decodeTail passes ASCII through unchanged', () => {
  assert.equal(decodeTail(Buffer.from('hello world')), 'hello world')
})

test('decodeTail strips leading UTF-8 continuation bytes from a mid-codepoint tail', () => {
  // '€' encodes as E2 82 AC. A byte-suffix that begins partway through it starts
  // with the continuation bytes 82 AC, which decodeTail must drop before the
  // next whole codepoint ('ok') so the result is valid UTF-8.
  const tail = Buffer.concat([Buffer.from([0x82, 0xac]), Buffer.from('ok')])
  assert.equal(decodeTail(tail), 'ok')
})

test('decodeTail returns an empty string for an empty buffer', () => {
  assert.equal(decodeTail(Buffer.alloc(0)), '')
})

test('compact status bounds large multibyte errors and never materializes task transcripts', () => {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE tasks (id TEXT,status TEXT,created_at TEXT,started_at TEXT,completed_at TEXT,commit_sha TEXT,error_message TEXT,log TEXT,prompt TEXT)')
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)').run('task', 'failed', '2026-01-01', null, null, null, '😀'.repeat(5000), 'private transcript'.repeat(100000), 'private prompt')
    const body = readTaskProjection(db, 'task', 'status')!
    assert.ok(Buffer.byteLength(body.errorMessage as string) <= STATUS_ERROR_BYTES)
    assert.ok(!(body.errorMessage as string).includes('\ufffd'))
    assert.equal(body.read_projection_version, 1)
    assert.ok(!('log' in body))
    assert.ok(!('prompt' in body))
  } finally { db.close() }
})
