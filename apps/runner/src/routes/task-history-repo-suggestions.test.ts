import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('optional exact repository suggestions stay independent of history navigation', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const { port } = server.address() as { port: number }
  const html = await (await fetch(`http://127.0.0.1:${port}/history`)).text()
  assert.match(html, /id="repo"[^>]*list="repo-suggestions"[^>]*aria-describedby="repo-discovery"/)
  assert.match(html, /<datalist id="repo-suggestions">/)
  const tick = () => new Promise(resolve => setImmediate(resolve))
  function harness() {
    const elements = new Map<string, any>()
    const element = () => ({ value: '', textContent: '', children: [] as any[],
      appendChild(child: any) { this.children.push(child) },
      replaceChildren(...children: any[]) { this.children = children } })
    const requests: { url: string; resolve: (value: any) => void; signal: AbortSignal }[] = []
    const timers = new Map<number, { fn: () => void; ms: number }>()
    let timerId = 0
    const pushed: string[] = []
    const listeners: Record<string, () => any> = {}
    let location = new URL('http://fake/history')
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
      URLSearchParams, AbortController,
      setTimeout(fn: () => void, ms: number) { timers.set(++timerId, { fn, ms }); return timerId },
      clearTimeout(id: number) { timers.delete(id) },
      window: { get location() { return location }, history: { pushState(_a: any, _b: any, url: string) {
        pushed.push(url); location = new URL(url, location)
      } }, addEventListener(name: string, fn: () => any) { listeners[name] = fn } },
      document: { getElementById(id: string) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) }, createElement: element },
      fetch: (url: string, options: any) => new Promise(resolve => requests.push({ url, resolve, signal: options.signal })),
    })
    return { el: (id: string) => elements.get(id), requests, timers, pushed,
      pop(url: string) { location = new URL(url, location); return listeners.popstate() },
      answer(i: number, tasks: any[] = [], next: string | null = null) {
        requests[i].resolve({ ok: true, json: async () => tasks, headers: { get: () => next } })
      } }
  }
  const h = harness()
  assert.equal(h.requests.length, 1)
  h.answer(0, [{ id: 'first', status: 'completed' }], 'cursor'); await tick()
  const discovery = h.el('repo').onfocus()
  assert.equal(h.requests[1].url, '/repos')
  const historical = '/retired/checkout ?&+'
  h.el('repo').value = historical
  const hostile = '<img src=x onerror=alert(1)>'
  h.answer(1, [{ name: 'same', path: '/a/same' }, { name: 'same', path: '/b/same' },
    { name: hostile, path: '/hostile/<script>' }, { name: 'same', path: '/a/same' }])
  await discovery
  assert.equal(h.el('repo').value, historical)
  assert.equal(h.pushed.length, 0)
  assert.equal(h.requests.length, 2)
  const options = h.el('repo-suggestions').children
  assert.deepEqual(options.map((o: any) => o.value), ['/a/same', '/b/same', '/hostile/<script>'])
  assert.equal(options[0].label, 'same — /a/same')
  assert.equal(options[1].label, 'same — /b/same')
  assert.equal(options[2].label, hostile + ' — /hostile/<script>')
  await h.el('repo').onfocus()
  h.el('older').onclick(); h.answer(2); await tick()
  assert.equal(new URL(h.requests[2].url, 'http://fake').searchParams.get('before'), 'cursor')
  h.el('filters').onsubmit({ preventDefault() {} })
  assert.equal(new URL(h.requests[3].url, 'http://fake').searchParams.get('repo'), historical)
  h.requests[3].resolve({ ok: true, json: async () => [{ id: '', status: 'completed' }] }); await tick()
  assert.match(h.el('message').textContent, /Invalid history response/)
  h.el('refresh').onclick()
  assert.equal(new URL(h.requests[4].url, 'http://fake').searchParams.has('repo'), false)
  h.answer(4); await tick()
  h.pop('/history?' + new URLSearchParams({ repo: historical, before: 'old' }))
  assert.equal(h.el('repo').value, historical)
  h.answer(5); await tick()
  assert.equal(h.requests.filter(r => r.url === '/repos').length, 1)

  for (const response of [
    { ok: false, status: 503 },
    { ok: true, json: async () => ({ repos: [] }) },
    { ok: true, json: async () => [{ name: 'bad', path: 'relative' }] },
    { ok: true, json: async () => [{ name: 'bad', path: '/bad\npath' }] },
    { ok: true, json: async () => { throw new SyntaxError('bad JSON') } },
    { ok: true, json: async () => Array(1001).fill({ name: 'a', path: '/a' }) },
  ]) {
    const f = harness(); f.answer(0); await tick()
    const pending = f.el('repo').onfocus()
    f.requests[1].resolve(response); await pending
    assert.match(f.el('repo-discovery').textContent, /unavailable/)
    f.el('repo').value = historical
    f.el('filters').onsubmit({ preventDefault() {} }); f.answer(2); await tick()
    assert.equal(new URL(f.requests[2].url, 'http://fake').searchParams.get('repo'), historical)
    await f.el('repo').onfocus()
    assert.equal(f.requests.length, 3)
  }
  for (const hangingBody of [false, true]) {
    const f = harness(); f.answer(0); await tick()
    const pending = f.el('repo').onfocus()
    let finishBody!: (value: any) => void
    if (hangingBody) f.requests[1].resolve({ ok: true, json: () => new Promise(resolve => { finishBody = resolve }) })
    await tick()
    f.el('repo').value = historical
    const deadline = [...f.timers.values()].find(timer => timer.ms === 5000)!
    deadline.fn(); await pending
    assert.equal(f.requests[1].signal.aborted, true)
    assert.match(f.el('repo-discovery').textContent, /unavailable/)
    const late = [{ name: 'late', path: '/late' }]
    if (hangingBody) finishBody(late)
    else f.answer(1, late)
    await tick()
    assert.equal(f.el('repo-suggestions')?.children.length ?? 0, 0)
    assert.equal(f.el('repo').value, historical)
    assert.equal(f.requests.length, 2)
    assert.equal(f.pushed.length, 0)
  }
})
