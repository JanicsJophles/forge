import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('HEAD /:id/log reports size and status headers with no body', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-log-head-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = path.join(directory, 'no-env-file')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { taskLogRouter } = await import('./task-log.js')
  const { db } = await import('../db/schema.js')
  t.after(() => db.close())
  const insert = db.prepare(
    "INSERT INTO tasks (id, repo, branch, prompt, status, log) VALUES (?, '/fake', 'test', 'test', ?, ?)")
  // Unicode + embedded NUL so X-Total-Bytes must reflect the BYTE length, not characters.
  const log = 'a😀é中\u0000\n'.repeat(3000)
  const expected = Buffer.from(log)
  insert.run('running', 'running', log)
  insert.run('empty', 'done', '')
  insert.run('null', 'failed', null)
  const app = express().use('/tasks', taskLogRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()))
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/tasks`
  async function head(id: string, status = 200) {
    const response = await fetch(`${base}/${id}/log`, { method: 'HEAD' })
    assert.equal(response.status, status, id)
    return response
  }

  // Existing task with a non-empty log: byte length, next offset == total, status.
  const running = await head('running')
  assert.equal(running.headers.get('x-total-bytes'), String(expected.length))
  assert.equal(running.headers.get('x-next-offset'), String(expected.length))
  assert.equal(running.headers.get('x-task-status'), 'running')
  assert.equal(Buffer.from(await running.arrayBuffer()).length, 0)

  // Empty and NULL logs report zero bytes but still carry the status.
  for (const [id, status] of [['empty', 'done'], ['null', 'failed']] as const) {
    const response = await head(id)
    assert.equal(response.headers.get('x-total-bytes'), '0')
    assert.equal(response.headers.get('x-next-offset'), '0')
    assert.equal(response.headers.get('x-task-status'), status)
    assert.equal(Buffer.from(await response.arrayBuffer()).length, 0)
  }

  // Unknown id: 404 with an empty body and no paging headers.
  const missing = await head('missing', 404)
  assert.equal(missing.headers.get('x-total-bytes'), null)
  assert.equal(Buffer.from(await missing.arrayBuffer()).length, 0)
})
