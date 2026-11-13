import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'

const source = await readFile(new URL('./task-log-view.ts', import.meta.url), 'utf8')
test('bounded initial recorded commits are escaped, explicit for legacy nulls and beside review', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-log-commit-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = path.join(directory, 'no-env-file')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { db } = await import('../db/schema.js')
  const { taskLogViewRouter } = await import('./task-log-view.js')
  t.after(() => db.close())
  const server = express().use('/tasks', taskLogViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  for (const [id, sha, expected] of [
    ['completed', 'abc123', 'abc123'],
    ['legacy', null, 'None recorded'],
    ['hostile', '</code><script>"&', '&lt;/code&gt;&lt;script&gt;&quot;&amp;'],
    ['bounded', 'a'.repeat(1000), 'a'.repeat(256)],
  ]) {
    db.prepare("INSERT INTO tasks (id, repo, branch, status, prompt, commit_sha) VALUES (?, '/local/repo', 'test', 'completed', '', ?)").run(id, sha)
    const html = await (await fetch(`http://127.0.0.1:${address.port}/tasks/${id}/log/view`)).text()
    assert.ok(html.includes(`Recorded commit: <code id="recordedCommit">${expected}</code> · <a href="/tasks/${id}/changes/view">Review task changes</a>`))
    assert.doesNotMatch(html, /github\.com\/local/)
  }
  assert.match(source, /substr\(commit_sha, 1, 256\) AS commit_sha/)
})

function viewer(t: any) {
  const elements = new Map<string, any>()
  const requests: Array<{ resolve: (response: any) => void }> = []
  const listeners = new Map<string, (e: any) => void>()
  function element(): any { return { textContent: '', value: '', hidden: true, disabled: false, childNodes: [], appendChild() {}, remove() {} } }
  elements.set('recordedCommit', { ...element(), textContent: 'None recorded' })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const script = source.match(/    <script>([\s\S]*?)<\/script>/)![1]
    .replace('${streamLiteral}', JSON.stringify('/tasks/test/stream'))
    .replace('${statusLiteral}', JSON.stringify('running'))
  runInNewContext(script, {
    document: { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)
    }, createElement: element, createTextNode: element },
    sessionStorage: { getItem: () => '' }, AbortController, setTimeout, clearTimeout,
    EventSource: class { addEventListener(name: string, fn: (e: any) => void) { listeners.set(name, fn) }; close() {} },
    fetch: () => new Promise(resolve => requests.push({ resolve })),
  })
  return {
    elements, requests,
    event: (name: string) => listeners.get(name)!({ data: JSON.stringify('auto-commit failed') }),
    respond(index: number, task: any) { requests[index].resolve({ ok: true, json: async () => task }) },
  }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
for (const [event, status, sha] of [
  ['complete', 'completed', 'eventual-sha'],
  ['complete', 'completed', null], // successful auto-commit with no changes
  ['error', 'failed', null], // failed auto-commit
] as const) {
  test(`live ${status} with ${sha ?? 'no commit'} refreshes and survives late running snapshot`, async t => {
    const v = viewer(t)
    v.event(event)
    v.respond(1, { status, commitSha: sha })
    await flush()
    const expected = sha ?? 'None recorded'
    assert.equal(v.elements.get('recordedCommit').textContent, expected)
    v.respond(0, { status: 'running', commitSha: null })
    await flush()
    assert.equal(v.elements.get('recordedCommit').textContent, expected)
    assert.equal(v.elements.get('status').textContent, status)
  })
}
test('hostile live commit uses textContent; HTTP failures and hung bodies retain metadata', async t => {
  for (const mode of ['http', 'body', 'running']) {
    const v = viewer(t)
    const hostile = '</code><script>unsafe</script>'
    v.respond(0, { status: 'running', commitSha: hostile })
    await flush()
    v.event('complete')
    if (mode === 'running') v.respond(1, { status: 'running', commitSha: null })
    else v.requests[1].resolve({ ok: mode !== 'http', json: () => new Promise(() => {}) })
    await flush()
    t.mock.timers.tick(5000)
    await flush()
    assert.equal(v.elements.get('recordedCommit').textContent, hostile)
    t.mock.timers.reset()
  }
})

test('initial status body deadline retains commit and ignores a late successful body', async t => {
  const v = viewer(t)
  v.elements.get('recordedCommit').textContent = 'stored-sha'
  let resolve!: (value: any) => void
  v.requests[0].resolve({ ok: true, json: () => new Promise(r => { resolve = r }) })
  await flush()
  t.mock.timers.tick(5000)
  await flush()
  resolve({ status: 'running', commitSha: null })
  await flush()
  assert.equal(v.elements.get('recordedCommit').textContent, 'stored-sha')
})
