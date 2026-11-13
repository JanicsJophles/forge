import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { rootRouter } from './root.js'

class Element {
  private text = ''
  children: Element[] = []
  set textContent(value: string) { this.text = value; this.children = [] }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join('') }
  appendChild(child: Element) { this.children.push(child) }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const health = (version: string) => ({ version, acceptingTasks: true, queuedOrRunning: 0, maxConcurrentTasks: 2 })
const tasks = (status: string) => [{ id: 'abcdefgh', repo: '/repo', status }]
type Reply = { ok: boolean; json: () => Promise<unknown> }

for (const endpoint of ['/tasks/stats']) {
  for (const phase of ['fetch', 'body']) {
    test(`${endpoint} hung ${phase}: deadline, bounded requests, late fencing and recovery`, async () => {
      const server = express().use(rootRouter).listen(0, '127.0.0.1')
      await new Promise<void>(resolve => server.once('listening', resolve))
      let html: string
      try {
        html = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)).text()
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
      const elements = new Map<string, Element>()
      const el = (id: string) => {
        if (!elements.has(id)) elements.set(id, new Element())
        return elements.get(id)!
      }
      let now = 0
      let timerId = 0
      const timers = new Map<number, { at: number; callback: () => void }>()
      const advance = async (ms: number) => {
        now += ms
        for (const [id, timer] of timers) {
          if (timer.at <= now) { timers.delete(id); timer.callback() }
        }
        await flush()
      }
      const requests: { url: string; signal: AbortSignal; resolve: (reply: Reply) => void }[] = []
      runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
        document: { getElementById: el, createElement: () => new Element() },
        AbortController,
        fetch: (url: string, options: { signal: AbortSignal }) =>
          new Promise<Reply>(resolve => requests.push({ url, signal: options.signal, resolve })),
        setTimeout: (callback: () => void, ms: number) => {
          timers.set(++timerId, { at: now + ms, callback }); return timerId
        },
        clearTimeout: (id: number) => timers.delete(id),
      })
      await flush()
      const payload = (url: string, value: string) => url === '/tasks/stats' ? ({ total: value === 'recovered' ? 9 : 7, completed: value === 'recovered' ? 9 : 7, failed: 0, queued: 0, running: 0 }) : url === '/health' ? health(value) : tasks(value)
      const complete = (request: typeof requests[number], value: string) =>
        request.resolve({ ok: true, json: async () => payload(request.url, value) })
      // Seed both sections so timeout must retain successful values.
      requests.forEach(r => complete(r, 'seed'))
      await flush()
      await advance(5000)
      const hung = requests.find((r, i) => i >= 3 && r.url === endpoint)!
      let resolveBody!: (value: unknown) => void
      if (phase === 'body') {
        hung.resolve({ ok: true, json: () => new Promise(resolve => { resolveBody = resolve }) })
      }
      requests.filter((r, i) => i >= 3 && r !== hung).forEach(r => complete(r, 'healthy-1'))
      await flush()
      await advance(9999)
      assert.equal(hung.signal.aborted, false)
      await advance(1)
      assert.equal(hung.signal.aborted, true)
      const freshness = 'totals-freshness'
      const valueId = 'total-total'
      const healthyId = 'live-version'
      assert.match(el(freshness).textContent, /stale/)
      assert.match(el(valueId).textContent, /7/)
      for (let i = 0; i < 4; i++) {
        const count = requests.length
        await advance(5000)
        assert.equal(requests.length, count + 2)
        requests.slice(count).forEach(request => {
          assert.notEqual(request.url, endpoint)
          complete(request, `healthy-${i + 2}`)
        })
        await flush()
        assert.match(el(healthyId).textContent, new RegExp(`healthy-${i + 2}`))
      }
      // An abort-ignoring completion cannot clear stale state or publish old data.
      if (phase === 'body') resolveBody(payload(endpoint, 'obsolete'))
      else complete(hung, 'obsolete')
      await flush()
      assert.match(el(freshness).textContent, /stale/)
      assert.match(el(valueId).textContent, /7/)
      const count = requests.length
      await advance(5000)
      assert.equal(requests.length, count + 3)
      requests.slice(count).forEach(r => complete(r, 'recovered'))
      await flush()
      assert.equal(el(freshness).textContent, '')
      assert.equal(el(valueId).textContent, '9')
      assert.equal(timers.size, 1)
    })
  }
}

test('retained totals validate atomically, preserve zeros and recover after malformed or rejected reads', async () => {
  const server = express().use(rootRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    html = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  assert.match(html, /Retained task history/)
  assert.match(html, /not lifetime totals or scheduling guarantees/)
  for (const status of ['completed', 'failed', 'queued', 'running']) {
    assert.ok(html.includes(`href="/history?status=${status}"`))
  }
  assert.ok(html.includes('href="/history">Total:'))
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const zero = { total: 0, completed: 0, failed: 0, queued: 0, running: 0 }
  const mixed = { total: 10, completed: 4, failed: 3, queued: 2, running: 1 }
  let payload: unknown = null
  let failure = ''
  let updates = 0
  const timers: (() => void)[] = []
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById: el, createElement: () => new Element() },
    AbortController,
    clearTimeout: () => {},
    setTimeout: (callback: () => void, ms: number) => {
      if (ms === 5000) timers.push(callback)
      else assert.equal(ms, 10000)
    },
    fetch: async (url: string) => {
      if (url !== '/tasks/stats') {
        updates++
        return { ok: true, json: async () => url === '/health' ? health(String(updates)) : [] }
      }
      if (failure === 'fetch') throw new Error('offline')
      return { ok: failure !== 'http', json: async () => {
        if (failure === 'body') throw new Error('bad JSON')
        return payload
      } }
    },
  })
  await flush()
  assert.match(el('totals-freshness').textContent, /unavailable/)
  async function cycle(value: unknown, fail = '') {
    payload = value
    failure = fail
    assert.equal(timers.length, 1)
    const before = updates
    timers.shift()!()
    await flush()
    assert.equal(updates, before + 2)
    assert.equal(el('health-freshness').textContent, '')
    assert.equal(el('tasks-freshness').textContent, '')
  }
  for (const value of [zero, mixed]) {
    await cycle(value)
    for (const [key, count] of Object.entries(value)) assert.equal(el('total-' + key).textContent, String(count))
    assert.equal(el('totals-freshness').textContent, '')
  }
  const invalid: unknown[] = [null, [], {}, { ...mixed, total: 11 }]
  for (const key of Object.keys(mixed)) {
    for (const value of [undefined, -1, 0.5, NaN, Infinity, '0', true, Number.MAX_SAFE_INTEGER + 1]) {
      invalid.push({ ...mixed, [key]: value })
    }
  }
  for (const value of invalid) {
    await cycle(value)
    assert.match(el('totals-freshness').textContent, /stale/)
    for (const [key, count] of Object.entries(mixed)) assert.equal(el('total-' + key).textContent, String(count))
  }
  for (const fail of ['fetch', 'http', 'body']) {
    await cycle(zero, fail)
    assert.match(el('totals-freshness').textContent, /stale/)
    assert.equal(el('total-total').textContent, '10')
  }
  await cycle(zero)
  assert.equal(el('totals-freshness').textContent, '')
  for (const key of Object.keys(zero)) assert.equal(el('total-' + key).textContent, '0')
})
