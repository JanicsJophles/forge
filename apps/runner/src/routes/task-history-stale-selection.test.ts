import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('retained history labels successful selection through failed and timed-out navigation', async t => {
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
  requests[0].resolve({ ok: false, status: 503 }); await tick()
  assert.equal(el('rows').children.length, 0)
  assert.match(el('displayed').textContent, /No task history loaded/)
  el('retry').onclick(); await timeout()
  assert.equal(el('rows').children.length, 0)
  assert.match(el('displayed').textContent, /No task history loaded/)
  el('retry').onclick(); answer(2, 'running', 'first'); await tick()
  assert.doesNotMatch(el('displayed').textContent, /Stale/)

  el('repo').value = '/safe?<script>&'; el('status').value = 'running'
  el('filters').onsubmit({ preventDefault() {} })
  answer(3, 'running', 'second'); await tick()
  el('older').onclick(); answer(4, 'completed', 'third'); await tick()
  const caption = el('displayed').textContent
  const retained = el('rows').children[0]
  assert.match(caption, /Repository: \/safe\?<script>&; Status: running; Page 2/)
  for (const mode of ['http', 'timeout']) {
    el('repo').value = '/failed'; el('status').value = 'failed'
    el('filters').onsubmit({ preventDefault() {} })
    const failed = requests.length - 1
    if (mode === 'http') { requests[failed].resolve({ ok: false, status: 503 }); await tick() }
    else await timeout()
    assert.equal(el('rows').children[0], retained)
    assert.match(el('displayed').textContent, /Stale/)
    assert.ok(el('displayed').textContent.endsWith(caption))
    assert.match(el('message').textContent, /Requested Repository: \/failed; Status: failed; Page 1/)
    assert.equal(el('newer').disabled, false)
    assert.equal(el('older').disabled, false)
    el('refresh').onclick()
    const refreshed = requests.length - 1
    assert.equal(query(refreshed).get('repo'), '/safe?<script>&')
    assert.equal(query(refreshed).get('status'), 'running')
    assert.equal(query(refreshed).get('before'), 'second')
    // Fail refresh as well so the same retained DOM remains available.
    requests[refreshed].resolve({ ok: false, status: 503 }); await tick()
  }
  for (const mode of ['http', 'timeout']) {
    const retained = el('rows').children[0]
    el('older').onclick()
    const failed = requests.length - 1
    assert.equal(query(failed).get('before'), 'third')
    if (mode === 'http') { requests[failed].resolve({ ok: false, status: 503 }); await tick() }
    else await timeout()
    assert.equal(el('rows').children[0], retained)
    assert.match(el('displayed').textContent, /Stale/)
    assert.match(el('message').textContent, /Page 3/)
    el('retry').onclick()
    const retried = requests.length - 1
    assert.equal(requests[retried].url, requests[failed].url)
    answer(retried, 'running', 'fourth'); await tick()
    assert.doesNotMatch(el('displayed').textContent, /Stale/)
    assert.equal(el('retry').hidden, true)
    el('newer').onclick()
    assert.equal(query(requests.length - 1).get('before'), 'second')
    answer(requests.length - 1, 'completed', 'third'); await tick()
  }
  el('repo').value = '/failed'
  el('repo').onchange()
  const failed = requests.length - 1
  requests[failed].resolve({ ok: false, status: 503 }); await tick()
  el('retry').onclick()
  assert.equal(requests.at(-1)!.url, requests[failed].url)
  answer(requests.length - 1, 'failed', 'new-filter'); await tick()
  assert.match(el('displayed').textContent, /Repository: \/failed; Status: failed; Page 1/)
  assert.doesNotMatch(el('displayed').textContent, /Stale/)
  el('older').onclick(); answer(requests.length - 1, 'failed'); await tick()
  el('repo').value = '/another'; el('repo').onchange()
  requests.at(-1)!.resolve({ ok: false, status: 503 }); await tick()
  el('latest').onclick()
  assert.equal(query(requests.length - 1).get('repo'), '/failed')
  assert.equal(query(requests.length - 1).has('before'), false)
  answer(requests.length - 1, 'failed'); await tick()
  assert.equal(timers.size, 0)
})
