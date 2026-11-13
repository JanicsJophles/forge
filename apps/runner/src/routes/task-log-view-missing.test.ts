import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('missing live-log pages recover with inert escaped HTML; existing tasks retain streaming', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-log-missing-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = path.join(directory, 'no-env-file')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { taskLogViewRouter } = await import('./task-log-view.js')
  const { db } = await import('../db/schema.js')
  t.after(() => db.close())
  db.prepare("INSERT INTO tasks (id, repo, branch, prompt, log) VALUES ('existing', '/does-not-exist', 'test', 'Saved prompt', 'PRIVATE_RETAINED_TRANSCRIPT')").run()

  const server = express().use('/tasks', taskLogViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/tasks`
  for (const id of ['missing', '\"><script>alert(1)</script>&\'']) {
    const response = await fetch(`${base}/${encodeURIComponent(id)}/log/view`)
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type') ?? '', /text\/html/)
    const html = await response.text()
    assert.match(html, /Task not found/)
    assert.match(html, /may have been pruned/)
    assert.match(html, /href="\/history">History/)
    assert.match(html, /href="\/dashboard">Dashboard/)
    assert.doesNotMatch(html, /<script|EventSource|fetch\(|PRIVATE_RETAINED_TRANSCRIPT|Saved prompt/)
    if (id !== 'missing') {
      assert.match(html, /&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;&amp;&#39;/)
      assert.ok(!html.includes(id))
    }
  }
  const response = await fetch(`${base}/existing/log/view`)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /new EventSource/)
  assert.match(html, /\/tasks\/existing\/stream/)
  assert.match(html, /Saved prompt/)
  assert.match(html, /id="cancel"/)
  assert.match(html, /id="retry"/)
  assert.doesNotMatch(html, /PRIVATE_RETAINED_TRANSCRIPT|Task not found/)
})
