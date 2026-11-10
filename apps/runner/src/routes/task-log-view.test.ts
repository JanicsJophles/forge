import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
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

  const elements = new Map<string, any>()
  const listeners = new Map<string, (event: any) => void>()
  const requests: any[] = []
  let response: any = { ok: true, json: async () => ({ status: 'running' }) }
  function element() {
    return { hidden: false, disabled: false, value: '', textContent: '', children: [] as any[],
      appendChild(child: any) { this.children.push(child) }, remove() {} }
  }
  runInNewContext(body.match(/<script>([\s\S]*?)<\/script>/)![1], {
    AbortController, setTimeout, clearTimeout,
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element())
        return elements.get(id)
      },
      createElement: element, createTextNode: (text: string) => ({ textContent: text }),
    },
    EventSource: class {
      addEventListener(name: string, fn: (event: any) => void) { listeners.set(name, fn) }
      close() {}
    },
    sessionStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    fetch: async (url: string, options: any) => { requests.push({ url, options }); return response },
  })
  await new Promise(resolve => setImmediate(resolve))
  const cancel = elements.get('cancel')
  const retry = elements.get('retry')
  assert.equal(cancel.hidden, false)
  assert.equal(retry.hidden, true)
  elements.get('authToken').value = ' secret '
  response = { ok: false, status: 401, json: async () => ({ error: '<b>unauthorized</b>' }) }
  await cancel.onclick()
  assert.equal(requests.at(-1).options.method, 'DELETE')
  assert.equal(requests.at(-1).options.headers.Authorization, 'Bearer secret')
  assert.equal(elements.get('actionMessage').textContent, 'HTTP 401: <b>unauthorized</b>')
  assert.equal(cancel.disabled, false)
  listeners.get('status')!({ data: '"queued"' })
  assert.equal(cancel.hidden, false)
  listeners.get('complete')!({})
  assert.equal(cancel.hidden, true)
  assert.equal(retry.hidden, false)
  response = { ok: false, status: 409, json: async () => ({ error: 'conflict' }) }
  await retry.onclick()
  assert.equal(requests.at(-1).url, '/tasks/view-1/retry')
  assert.equal(requests.at(-1).options.method, 'POST')
  assert.match(elements.get('actionMessage').textContent, /HTTP 409: conflict/)
  response = { ok: true, json: async () => ({ taskId: '<new>' }) }
  await retry.onclick()
  assert.equal(elements.get('actionMessage').children[0].href, '/tasks/%3Cnew%3E/log/view')

  db.prepare("UPDATE tasks SET status = 'failed' WHERE id = 'view-1'").run()
  const terminalBody = await (await fetch(`${base}/tasks/view-1/log/view`)).text()
  assert.ok(terminalBody.includes('taskStatus("failed")'), 'initial terminal status initializes controls')

  // A crafted task id is escaped everywhere it is interpolated — the raw tag
  // must never survive into the served markup.
  const hostile = await fetch(`${base}/tasks/${encodeURIComponent('"><img src=x onerror=alert(1)>')}/log/view`)
  assert.equal(hostile.status, 200)
  const hostileBody = await hostile.text()
  assert.ok(!hostileBody.includes('<img src=x'), 'raw injected tag does not appear')
  assert.match(hostileBody, /&lt;img src=x/, 'the id is HTML-escaped in text context')
})
