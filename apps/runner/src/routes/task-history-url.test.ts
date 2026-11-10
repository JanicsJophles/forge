import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('mounted history restores URL filters, encodes applies and resets traversal on popstate', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const { port } = server.address() as { port: number }
  const path = '/repo?a&b=+ <script>evil</script>'
  const initial = '/history?' + new URLSearchParams({ repo: path, status: 'failed' })
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
      answer(i: number, next: string | null = null) { requests[i].resolve({ ok: true, json: async () => [{ id: 'task', repo: path, status: 'failed' }], headers: { get: () => next } }) },
    }
  }
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const h = harness(initial)
  assert.equal(h.el('repo').value, path)
  assert.equal(h.el('status').value, 'failed')
  assert.equal(h.query(0).get('repo'), path)
  assert.equal(h.query(0).get('status'), 'failed')
  h.answer(0, 'cursor'); await tick()
  h.el('older').onclick(); h.answer(1); await tick()
  h.el('repo').value = '/other &+'; h.el('status').value = 'running'
  h.el('filters').onsubmit({ preventDefault() {} })
  assert.equal(h.pushed.length, 1)
  assert.equal(new URL(h.pushed[0], 'http://fake').pathname, '/history')
  assert.equal(h.query(2).has('before'), false)
  h.requests[2].resolve({ ok: false, status: 503 }); await tick()
  assert.match(h.el('message').textContent, /Rows still show previous filters/)
  assert.equal(h.el('rows').children[0].children[2].textContent, path)
  h.el('retry').onclick(); h.answer(3, 'other-cursor'); await tick()
  const reloaded = harness(h.pushed[0]); reloaded.answer(0); await tick()
  assert.equal(reloaded.query(0).get('repo'), '/other &+')
  assert.equal(reloaded.query(0).get('status'), 'running')
  h.pop(initial)
  assert.equal(h.query(4).has('before'), false)
  assert.equal(h.query(4).get('repo'), path)
  assert.equal(h.el('repo').value, path)
  h.answer(4, 'cursor'); await tick()
  assert.equal(h.el('newer').disabled, true)
  assert.equal(h.el('latest').disabled, true)
  h.pop(h.pushed[0]); h.answer(5); await tick()
  assert.equal(h.query(5).get('status'), 'running')
  assert.equal(h.pushed.length, 1)
  const malformed = harness('/history?status=%3Cscript%3E&repo=%3Cimg%3E')
  assert.equal(malformed.el('status').value, '')
  assert.equal(malformed.query(0).has('status'), false)
  assert.equal(malformed.query(0).get('repo'), '<img>')
  malformed.answer(0); await tick()
  assert.match(malformed.el('message').textContent, /Invalid URL status ignored/)
})
