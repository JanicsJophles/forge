import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { rootRouter } from './root.js'

class Element {
  textContent = ''
  appendChild(_child: Element) {}
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('landing shows measured run age and provider limit through the existing health refresh', async () => {
  const server = express().use(rootRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    html = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  assert.match(html, /Oldest running age:/)
  assert.match(html, /Provider runtime limit:/)
  assert.match(html, /not a guaranteed completion or free-slot time/)
  assert.match(html, /Queued work has not necessarily started/)
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  let health: unknown = {}
  let failure: 'network' | 'http' | 'body' | null = 'network'
  const timers: (() => void)[] = []
  const requests: string[] = []
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById: el, createElement: () => new Element() },
    AbortController,
    clearTimeout: () => {},
    setTimeout: (callback: () => void, delay: number) => {
      if (delay === 5000) timers.push(callback)
      else assert.equal(delay, 10000)
    },
    fetch: async (url: string) => {
      requests.push(url)
      if (url === '/tasks/stats') return { ok: true, json: async () =>
        ({ total: 0, completed: 0, failed: 0, queued: 0, running: 0 }) }
      if (url !== '/health') {
        assert.equal(url, '/tasks?limit=5')
        return { ok: true, json: async () => [] }
      }
      if (failure === 'network') throw new Error('offline')
      return { ok: failure !== 'http', json: async () => {
        if (failure === 'body') throw new Error('bad JSON')
        return health
      } }
    },
  })
  await flush()
  assert.equal(el('oldest-running-age').textContent, 'unknown')
  assert.equal(el('task-timeout').textContent, 'unknown')
  assert.match(el('health-freshness').textContent, /unavailable/)
  async function cycle(value: unknown, fail: typeof failure = null) {
    health = value
    failure = fail
    assert.equal(timers.length, 1)
    timers.shift()!()
    await flush()
    assert.equal(timers.length, 1)
    assert.deepEqual(requests.splice(0).slice(-3), ['/tasks?limit=5', '/health', '/tasks/stats'])
  }
  async function readings(age: unknown, timeout: unknown, expectedAge: string, expectedLimit: string) {
    await cycle({ oldestRunningTaskAgeSeconds: age, taskTimeoutMs: timeout, acceptingTasks: false, queuedOrRunning: 2, maxConcurrentTasks: 2 })
    assert.equal(el('oldest-running-age').textContent, expectedAge)
    assert.equal(el('task-timeout').textContent, expectedLimit)
    assert.equal(el('health-freshness').textContent, '')
  }
  await readings(null, 3600000, 'no measured running age', '1h 0s')
  await readings(0, 0, '0s', '0s')
  await readings(90061, 3600000, '1d 1h 1m 1s', '1h 0s')
  for (const fail of ['network', 'http', 'body'] as const) {
    await cycle({}, fail)
    assert.equal(el('oldest-running-age').textContent, '1d 1h 1m 1s')
    assert.equal(el('task-timeout').textContent, '1h 0s')
    assert.match(el('health-freshness').textContent, /stale/)
  }
  for (const value of [undefined, -1, NaN, Infinity, -Infinity, '60', {}, true]) {
    await readings(value, value, 'unknown', 'unknown')
  }
  await readings(61.9, 1500, '1m 1s', '1s')
  await readings(5, null, '5s', 'unknown')
})
