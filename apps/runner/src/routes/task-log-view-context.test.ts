import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('log viewer projects and escapes launch context without reading prompt or log', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-log-context-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = path.join(directory, 'no-env-file')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { db } = await import('../db/schema.js')
  const { taskLogViewRouter } = await import('./task-log-view.js')
  t.after(() => db.close())
  const hostile = `</dd><script>alert("x")</script>&'`
  const insert = db.prepare(`INSERT INTO tasks
    (id, repo, branch, provider, model, auto_commit, prompt, log)
    VALUES (?, ?, ?, ?, ?, ?, 'PRIVATE_PROMPT', 'PRIVATE_LOG')`)
  insert.run('hostile', hostile, hostile, hostile, hostile, 1)
  insert.run('legacy', '/repo', 'topic', 'codex', null, null)
  insert.run('off', '/repo', 'topic', 'claude', 'saved-model', 0)

  // Observe the SQL actually prepared by requests against the throwaway DB.
  const queries: string[] = []
  const prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => {
    queries.push(sql)
    return prepare(sql)
  }) as typeof db.prepare
  t.after(() => { db.prepare = prepare })
  const server = express().use('/tasks', taskLogViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/tasks`
  const response = await fetch(`${base}/hostile/log/view`)
  assert.equal(response.status, 200)
  const html = await response.text()
  const escaped = '&lt;/dd&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;'
  assert.equal(html.split(escaped).length - 1, 4)
  assert.ok(!html.includes(hostile))
  assert.match(html, /<dt>Auto commit<\/dt><dd>on<\/dd>/)
  assert.doesNotMatch(html, /PRIVATE_PROMPT|PRIVATE_LOG/)
  const legacy = await (await fetch(`${base}/legacy/log/view`)).text()
  for (const [label, value] of [['Repository', '/repo'], ['Branch', 'topic'], ['Provider', 'codex'],
    ['Model', 'unspecified'], ['Auto commit', 'unspecified']]) {
    assert.ok(legacy.includes(`<dt>${label}</dt><dd>${value}</dd>`))
  }
  const off = await (await fetch(`${base}/off/log/view`)).text()
  assert.match(off, /<dt>Auto commit<\/dt><dd>off<\/dd>/)
  assert.match(off, /<dt>Model<\/dt><dd>saved-model<\/dd>/)
  const missing = await fetch(`${base}/missing/log/view`)
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'task not found' })
  assert.equal(queries.length, 4)
  for (const query of queries) {
    assert.equal(query, 'SELECT status, repo, branch, provider, model, auto_commit FROM tasks WHERE id = ?')
    assert.doesNotMatch(query, /\b(prompt|log|error_message)\b|\*/i)
  }
})
