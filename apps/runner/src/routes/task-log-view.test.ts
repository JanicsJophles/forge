import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

// The live log viewer is a read endpoint: a known task id yields an HTML page
// that wires up the SSE stream; an unknown id yields the same JSON 404 the
// sibling log routes return. A hostile id must never escape into markup.
test('GET /:id/log/view serves the SSE viewer and 404s a missing task', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-log-view-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = path.join(directory, 'no-env-file')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { taskLogViewRouter } = await import('./task-log-view.js')
  const { db } = await import('../db/schema.js')
  t.after(() => db.close())
  const insert = db.prepare("INSERT INTO tasks (id, repo, branch, prompt, log) VALUES (?, '/fake', 'test', 'test', ?)")
  insert.run('view-1', 'hello world\n')
  insert.run('"><img src=x onerror=alert(1)>', 'x')

  const app = express().use('/tasks', taskLogViewRouter)
  app.use((_req, res) => res.status(404).json({ error: 'not found' }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`

  // Missing task → JSON 404 matching the byte-slice log route's contract.
  const missing = await fetch(`${base}/tasks/nope/log/view`)
  assert.equal(missing.status, 404)
  assert.match(missing.headers.get('content-type') ?? '', /application\/json/)
  assert.deepEqual(await missing.json(), { error: 'task not found' })

  // Known task → HTML page that connects to this task's /stream endpoint.
  const ok = await fetch(`${base}/tasks/view-1/log/view`)
  assert.equal(ok.status, 200)
  assert.match(ok.headers.get('content-type') ?? '', /text\/html/)
  const body = await ok.text()
  assert.ok(body.includes('/tasks/view-1/stream'), 'page embeds the task stream URL')
  assert.match(body, /new EventSource/, 'page opens an EventSource')
  assert.match(body, /createTextNode/, 'log text is appended inertly, never via innerHTML')
  assert.doesNotMatch(body, /\.innerHTML/, 'viewer never assigns innerHTML')

  // A crafted task id is escaped everywhere it is interpolated — the raw tag
  // must never survive into the served markup.
  const hostile = await fetch(`${base}/tasks/${encodeURIComponent('"><img src=x onerror=alert(1)>')}/log/view`)
  assert.equal(hostile.status, 200)
  const hostileBody = await hostile.text()
  assert.ok(!hostileBody.includes('<img src=x'), 'raw injected tag does not appear')
  assert.match(hostileBody, /&lt;img src=x/, 'the id is HTML-escaped in text context')
})
