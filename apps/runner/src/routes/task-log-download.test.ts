import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('log download serves a sanitized attachment and exposes the task status', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-log-dl-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = path.join(directory, 'no-env-file')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { taskLogRouter } = await import('./task-log.js')
  const { db } = await import('../db/schema.js')
  t.after(() => db.close())
  const insert = db.prepare(
    "INSERT INTO tasks (id, repo, branch, prompt, log, status) VALUES (?, '/fake', 'test', 'test', ?, ?)")
  insert.run('run-1', 'line one\nline two\n', 'running')
  insert.run('done-1', 'finished\n', 'succeeded')
  // A task id with characters that must never reach the header verbatim.
  insert.run('a/b"c; drop\n2', 'x\n', 'queued')
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
  const get = (id: string, query = '') => fetch(`${base}/${encodeURIComponent(id)}/log${query}`)

  // download=1 with format=text sends an attachment named after the task id,
  // and still carries the paging headers of a normal text slice.
  const dl = await get('run-1', '?format=text&download=1')
  assert.equal(dl.status, 200)
  assert.equal(dl.headers.get('content-disposition'), 'attachment; filename="forge-task-run-1.log"')
  assert.equal(dl.headers.get('x-task-status'), 'running')
  assert.equal(dl.headers.get('x-total-bytes'), '18')
  assert.equal(await dl.text(), 'line one\nline two\n')

  // The task id is sanitized to [A-Za-z0-9._-] so it cannot inject header bytes.
  const injected = await get('a/b"c; drop\n2', '?format=text&download=1')
  assert.equal(injected.status, 200)
  assert.equal(
    injected.headers.get('content-disposition'),
    'attachment; filename="forge-task-a_b_c__drop_2.log"')

  // X-Task-Status rides along on non-download responses too, so a polling tail
  // loop over the base64 JSON path can stop once the task is terminal.
  const terminal = await get('done-1', '?tailLines=1')
  assert.equal(terminal.status, 200)
  assert.equal(terminal.headers.get('x-task-status'), 'succeeded')
  assert.equal(terminal.headers.get('content-disposition'), null)

  // download is only honored with format=text: on the base64 JSON path it is a
  // 400, and any value other than 1 is rejected regardless of format.
  const noFormat = await get('run-1', '?download=1')
  assert.equal(noFormat.status, 400)
  assert.equal(typeof (await noFormat.json()).error, 'string')
  for (const bad of ['?format=text&download=0', '?format=text&download=', '?format=text&download=yes',
    '?format=text&download=1&download=1', '?format=text&download[]=1']) {
    const response = await get('run-1', bad)
    assert.equal(response.status, 400, bad)
    assert.equal(typeof (await response.json()).error, 'string', bad)
  }

  // Unknown ids still 404 before any status or attachment header is produced.
  const missing = await get('nope', '?format=text&download=1')
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('content-disposition'), null)
})
