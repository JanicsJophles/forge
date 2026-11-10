import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('log pages link to their own changes for every status without loading transcripts or probing Git', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-log-changes-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = path.join(directory, 'no-env-file')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { db } = await import('../db/schema.js')
  const { taskLogViewRouter } = await import('./task-log-view.js')
  t.after(() => db.close())
  const statuses = ['queued', 'running', 'completed', 'failed', 'cancelled']
  const ids = statuses.map(status => `${status}/"<&'?#% 雪`)
  const insert = db.prepare(`INSERT INTO tasks (id, repo, branch, status, prompt, log)
    VALUES (?, '/nonexistent/repository', 'test', ?, '', 'PRIVATE_LOG')`)
  ids.forEach((id, index) => insert.run(id, statuses[index]))
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
  for (const id of ids) {
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks/${encodeURIComponent(id)}/log/view`)
    assert.equal(response.status, 200)
    const html = await response.text()
    const href = `/tasks/${encodeURIComponent(id).replace(/'/g, '&#39;')}/changes/view`
    assert.ok(html.includes(`<a href="${href}">Changes</a>`))
    assert.equal((html.match(/>Changes<\/a>/g) ?? []).length, 1)
    assert.doesNotMatch(html, /PRIVATE_LOG/)
    assert.ok(!html.includes(id))
    assert.match(html, />raw text<\/a>/)
    assert.match(html, />download<\/a>/)
    assert.match(html, /href="\/dashboard"/)
  }
  assert.equal(queries.length, ids.length)
  for (const query of queries) {
    assert.match(query, /^SELECT status, repo, branch, provider, model, auto_commit[\s,]/)
    assert.doesNotMatch(query, /\b(log|error_message)\b|SELECT\s+\*/i)
  }
  // Navigation stays a static anchor in this DB-only route, with no Git imports.
  const source = await readFile(new URL('./task-log-view.ts', import.meta.url), 'utf8')
  assert.deepEqual([...source.matchAll(/^import .* from '(.*)'/gm)].map(match => match[1]),
    ['express', '../db/schema.js'])
})
