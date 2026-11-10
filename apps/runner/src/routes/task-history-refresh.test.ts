import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('refresh preserves successful filtered pages and fences deadline and superseded reads', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const { port } = server.address() as { port: number }
  const html = await (await fetch(`http://127.0.0.1:${port}/history`)).text()
  const elements = new Map<string, any>()
  const element = () => ({ value: '', textContent: '', disabled: false, hidden: false, children: [] as any[],
    appendChild(child: any) { this.children.push(child) },
    replaceChildren(...children: any[]) { this.children = children },
  })
  const requests: { url: string; signal: AbortSignal; resolve: (value: any) => void }[] = []
  const timers = new Map<number, () => void>()
  let timerId = 0
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)
    }, createElement: element }, URLSearchParams, AbortController,
    setTimeout(callback: () => void, delay: number) {
      assert.equal(delay, 15000); timers.set(++timerId, callback); return timerId
    },
    clearTimeout(id: number) { timers.delete(id) },
    fetch: (url: string, options: { signal: AbortSignal }) => new Promise(resolve => {
      requests.push({ url, signal: options.signal, resolve })
    }),
  })
  const el = (id: string) => elements.get(id)
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const answer = (index: number, status: string, next: string | null = null) => requests[index].resolve({
    ok: true, json: async () => [{ id: 'task', status }], headers: { get: () => next },
  })
  const outcome = () => el('rows').children[0].children[0].textContent
  const query = (index: number) => new URL(requests[index].url, 'http://fake').searchParams
  const timeout = async () => {
    assert.equal(timers.size, 1)
    const callback = [...timers.values()][0]
    callback(); await tick()
    assert.match(el('message').textContent, /timed out/)
    assert.equal(el('retry').hidden, false)
    assert.equal(el('refresh').disabled, false)
  }
  answer(0, 'running', 'older'); await tick()
  el('refresh').onclick()
  answer(1, 'completed', 'older'); await tick()
  assert.equal(outcome(), 'completed')
  assert.equal(query(1).has('before'), false)

  el('repo').value = '/repo?a&b'; el('status').value = 'running'
  el('filters').onsubmit({ preventDefault() {} })
  answer(2, 'running', 'opaque?&'); await tick()
  el('older').onclick(); answer(3, 'running', 'oldest'); await tick()
  el('repo').value = '/unapplied'
  el('status').value = 'failed'
  el('refresh').onclick()
  assert.equal(query(4).get('before'), 'opaque?&')
  assert.equal(query(4).get('repo'), '/repo?a&b')
  assert.equal(query(4).get('status'), 'running')
  answer(4, 'completed', 'oldest'); await tick()
  assert.equal(outcome(), 'completed')
  assert.equal(el('newer').disabled, false)
  assert.equal(el('latest').disabled, false)

  // GET never resolves; retry must use precisely the timed-out page.
  el('refresh').onclick(); await timeout()
  assert.equal(requests[5].signal.aborted, true)
  assert.equal(outcome(), 'completed')
  assert.equal(el('newer').disabled, false)
  el('retry').onclick()
  assert.equal(requests[6].url, requests[5].url)
  answer(6, 'running', 'oldest'); await tick()
  answer(5, 'late GET', 'wrong'); await tick()
  assert.equal(outcome(), 'running')

  // Headers arrive, but the response body never resolves until after timeout.
  el('refresh').onclick()
  let resolveBody!: (value: any) => void
  requests[7].resolve({ ok: true, headers: { get: () => 'wrong' },
    json: () => new Promise(resolve => { resolveBody = resolve }) })
  await tick(); await timeout()
  el('retry').onclick(); answer(8, 'completed', 'oldest'); await tick()
  resolveBody([{ id: 'late', status: 'late body' }]); await tick()
  assert.equal(outcome(), 'completed')
  el('older').onclick()
  assert.equal(query(9).get('before'), 'oldest')
  // Filter changes supersede navigation, including its pending body read.
  let staleBody!: (value: any) => void
  requests[9].resolve({ ok: true, headers: { get: () => 'wrong' },
    json: () => new Promise(resolve => { staleBody = resolve }) })
  await tick()
  el('repo').onchange()
  answer(10, 'new filter'); await tick()
  staleBody([{ status: 'stale' }]); await tick()
  assert.equal(outcome(), 'new filter')
  assert.equal(el('newer').disabled, true)
  assert.equal(el('older').disabled, true)
  assert.equal(timers.size, 0)
})
