import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('provider history restores, paginates, retries and retains successful selections', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const { port } = server.address() as { port: number }
  const path = '/repo?a&b=+ <script>evil</script>'
  const initial = '/history?' + new URLSearchParams({ repo: path, status: 'failed', provider: 'codex' })
  const response = await fetch(`http://127.0.0.1:${port}${initial}`)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.doesNotMatch(html, /innerHTML/)
  function harness(url: string) {
    const elements = new Map<string, any>()
    const element = () => ({ value: '', textContent: '', disabled: false, children: [] as any[],
      appendChild(child: any) { this.children.push(child) }, replaceChildren(...children: any[]) { this.children = children } })
    const requests: { url: string; resolve: (value: any) => void }[] = []
    const pushed: string[] = []
    const listeners: Record<string, () => any> = {}
    let location = new URL(url, 'http://fake')
    const browser = { get location() { return location }, history: { pushState(_a: any, _b: any, value: string) {
      pushed.push(value); location = new URL(value, location)
    } }, addEventListener(name: string, callback: () => any) { listeners[name] = callback } }
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
      window: browser, URLSearchParams, AbortController, setTimeout, clearTimeout,
      document: { getElementById(id: string) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) }, createElement: element },
      fetch: (url: string) => new Promise(resolve => requests.push({ url, resolve })),
    })
    return { el: (id: string) => elements.get(id), pushed, requests,
      query: (i: number) => new URL(requests[i].url, 'http://fake').searchParams,
      pop(url: string) { location = new URL(url, location); return listeners.popstate() },
      answer(i: number, next: string | null = null) { requests[i].resolve({ ok: true, json: async () => [{ id: 'task', repo: path, status: 'failed', provider: 'codex' }], headers: { get: () => next } }) },
    }
  }
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const h = harness(initial)
  assert.equal(h.el('repo').value, path)
  assert.equal(h.el('status').value, 'failed')
  assert.equal(h.query(0).get('repo'), path)
  assert.equal(h.query(0).get('status'), 'failed')
  assert.equal(h.el('provider').value, 'codex')
  assert.equal(h.query(0).get('provider'), 'codex')
  h.answer(0, 'cursor'); await tick()
  h.el('older').onclick(); h.answer(1); await tick()
  assert.equal(h.query(1).get('provider'), 'codex')
  h.el('repo').value = '/other &+'; h.el('status').value = 'running'; h.el('provider').value = 'claude'
  h.el('filters').onsubmit({ preventDefault() {} })
  assert.equal(h.pushed.length, 1)
  assert.equal(new URL(h.pushed[0], 'http://fake').pathname, '/history')
  assert.equal(h.query(2).has('before'), false)
  assert.equal(h.query(2).get('provider'), 'claude')
  assert.equal(new URL(h.pushed[0], 'http://fake').searchParams.get('provider'), 'claude')
  h.requests[2].resolve({ ok: false, status: 503 }); await tick()
  assert.match(h.el('message').textContent, /Rows still show previous filters/)
  assert.match(h.el('displayed').textContent, /Provider: codex/)
  assert.match(h.el('message').textContent, /Provider: claude/)
  assert.equal(h.el('rows').children[0].children[2].textContent, path)
  h.el('retry').onclick()
  assert.equal(h.query(3).get('repo'), '/other &+')
  assert.equal(h.query(3).get('status'), 'running')
  assert.equal(h.query(3).get('provider'), 'claude')
  h.answer(3, 'other-cursor'); await tick()
  const reloaded = harness(h.pushed[0]); reloaded.answer(0); await tick()
  assert.equal(reloaded.query(0).get('repo'), '/other &+')
  assert.equal(reloaded.query(0).get('status'), 'running')
  assert.equal(reloaded.query(0).get('provider'), 'claude')
  h.pop(initial)
  assert.equal(h.query(4).has('before'), false)
  assert.equal(h.query(4).get('repo'), path)
  assert.equal(h.query(4).get('provider'), 'codex')
  assert.equal(h.el('repo').value, path)
  h.answer(4, 'cursor'); await tick()
  assert.equal(h.el('newer').disabled, true)
  assert.equal(h.el('latest').disabled, true)
  h.pop(h.pushed[0]); h.answer(5); await tick()
  assert.equal(h.query(5).get('status'), 'running')
  assert.equal(h.pushed.length, 1)
  // A failed back/forward read retains the successful page for Refresh,
  // while Retry keeps the URL's requested filters and cursor.
  const linked = '/history?' + new URLSearchParams({ repo: path, status: 'failed', provider: 'codex', before: 'anchor?&+' })
  h.pop(linked)
  assert.equal(h.query(6).get('before'), 'anchor?&+')
  h.requests[6].resolve({ ok: false, status: 503 }); await tick()
  h.el('refresh').onclick()
  assert.equal(h.query(7).get('repo'), '/other &+')
  assert.equal(h.query(7).get('status'), 'running')
  assert.equal(h.query(7).get('provider'), 'claude')
  h.answer(7); await tick()
  h.pop(linked)
  h.requests[8].resolve({ ok: false, status: 503 }); await tick()
  h.el('retry').onclick()
  assert.equal(h.requests[9].url, h.requests[8].url)
  h.answer(9); await tick()
  assert.equal(h.query(9).get('provider'), 'codex')
  h.el('provider').value = ''; h.el('provider').onchange()
  assert.equal(h.query(10).has('before'), false)
  assert.equal(h.query(10).has('provider'), false)
  h.answer(10); await tick()
  assert.equal(h.el('newer').disabled, true)
  const fromLink = harness(linked)
  assert.equal(fromLink.query(0).get('repo'), path)
  assert.equal(fromLink.query(0).get('status'), 'failed')
  assert.equal(fromLink.query(0).get('before'), 'anchor?&+')
  fromLink.answer(0); await tick()
  const malformed = harness('/history?status=%3Cscript%3E&repo=%3Cimg%3E&provider=unknown')
  assert.equal(malformed.el('status').value, '')
  assert.equal(malformed.query(0).has('status'), false)
  assert.equal(malformed.query(0).get('repo'), '<img>')
  malformed.answer(0); await tick()
  assert.match(malformed.el('message').textContent, /Invalid URL status ignored/)
  assert.equal(malformed.query(0).has('provider'), false)
  assert.match(malformed.el('message').textContent, /Invalid URL provider ignored/)
})

test('provider API filters interleaved saved rows before cursor and limit with exact validation', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'forge-provider-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = join(directory, 'absent')
  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
  const insert = db.prepare(`INSERT INTO tasks
    (id, repo, branch, prompt, status, created_at, provider, log)
    VALUES (?, ?, 'test', ?, ?, ?, ?, ?)`)
  for (let i = 0; i < 80; i++) {
    insert.run('task-' + String(i).padStart(2, '0'), i % 3 ? '/repo' : '/other',
      'p'.repeat(5000), i % 5 ? 'failed' : 'completed',
      '2026-11-13T00:00:00Z', i % 2 ? 'codex' : 'claude', 'l'.repeat(10000))
  }
  const server = express().use('/tasks', tasksRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const { port } = server.address() as { port: number }
  const get = (query: string) => fetch('http://127.0.0.1:' + port + '/tasks?' + query)
  for (const provider of ['claude', 'codex']) {
    for (const combined of [false, true]) {
      const query = new URLSearchParams({ provider, limit: '7' })
      if (combined) { query.set('repo', '/repo'); query.set('status', 'failed') }
      const ids: string[] = []
      for (;;) {
        const response = await get(query.toString())
        assert.equal(response.status, 200)
        const rows = await response.json() as any[]
        assert.ok(rows.length <= 7)
        for (const row of rows) {
          assert.equal(row.provider, provider)
          assert.ok(row.prompt.length <= 4096)
          assert.ok(row.log.length <= 8192)
          if (combined) { assert.equal(row.repo, '/repo'); assert.equal(row.status, 'failed') }
          ids.push(row.id)
        }
        const before = response.headers.get('X-Next-Before')
        if (!before) break
        query.set('before', before)
      }
      const expected = Array.from({ length: 80 }, (_, i) => i).reverse()
        .filter(i => (i % 2 ? 'codex' : 'claude') === provider && (!combined || (i % 3 && i % 5)))
        .map(i => 'task-' + String(i).padStart(2, '0'))
      assert.deepEqual(ids, expected)
    }
  }
  for (const value of ['', 'unknown', 'Claude', '%20', 'codex%20', 'codex&provider=codex',
    'codex&provider=claude', 'codex&provider[]=codex']) {
    assert.equal((await get('provider=' + value)).status, 400, value)
  }
  for (const query of ['provider[x]=codex', 'provider[]=codex']) {
    assert.equal((await get(query)).status, 400)
  }
  const omitted = await get('limit=100')
  assert.equal(omitted.status, 200)
  assert.equal((await omitted.json() as any[]).length, 80)
})
