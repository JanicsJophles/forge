import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { rootRouter } from './root.js'

class Element {
  textContent = ''
  appendChild() {}
}
const admission = { acceptingTasks: true, queuedOrRunning: 0, maxConcurrentTasks: 2 }
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('landing disk headroom uses health refresh, validates values and retains stale measurements', async () => {
  const server = express().use(rootRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    html = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const label of ['Repository volume free', 'Database volume free', 'Minimum free disk required']) {
    assert.ok(html.includes(label))
  }
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const timers: (() => void)[] = []
  const urls: string[] = []
  let health: unknown = {}
  let fail = true
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById: el, createElement: () => new Element() },
    AbortController,
    fetch: async (url: string) => {
      urls.push(url)
      if (url === '/health' && fail) throw new Error('offline')
      return { ok: true, json: async () => url === '/health' ? health : url === '/tasks/stats'
        ? { total: 0, completed: 0, failed: 0, queued: 0, running: 0 } : [] }
    },
    setTimeout: (callback: () => void, ms: number) => {
      if (ms === 5000) timers.push(callback)
      else assert.equal(ms, 10000)
    },
    clearTimeout: () => {},
  })
  const values = () => ['repo-disk', 'data-disk', 'min-disk'].map(id => el(id).textContent)
  const cycle = async () => {
    assert.equal(timers.length, 1)
    timers.shift()!()
    await flush()
    assert.deepEqual(urls.splice(0), ['/tasks?limit=5', '/health', '/tasks/stats'])
  }
  await flush()
  assert.deepEqual(values(), ['unknown', 'unknown', 'unknown'])
  assert.match(el('health-freshness').textContent, /unavailable/)
  assert.deepEqual(urls.splice(0), ['/tasks?limit=5', '/health', '/tasks/stats'])
  fail = false
  health = { ...admission, freeDiskMb: 1234.5, dataFreeDiskMb: 9876, minFreeDiskMb: 0 }
  await cycle()
  assert.deepEqual(values(), ['1234.5 MiB', '9876 MiB', '0 MiB'])
  assert.equal(el('health-freshness').textContent, '')
  fail = true
  await cycle()
  assert.deepEqual(values(), ['1234.5 MiB', '9876 MiB', '0 MiB'])
  assert.match(el('health-freshness').textContent, /stale/)
  fail = false
  for (const invalid of [null, undefined, -1, NaN, Infinity, -Infinity, '42', {}]) {
    health = { ...admission, freeDiskMb: invalid, dataFreeDiskMb: invalid, minFreeDiskMb: invalid }
    await cycle()
    assert.deepEqual(values(), ['unknown', 'unknown', 'unknown'])
    assert.equal(el('health-freshness').textContent, '')
  }
  health = { ...admission, freeDiskMb: 0, dataFreeDiskMb: null, minFreeDiskMb: 512 }
  await cycle()
  assert.deepEqual(values(), ['0 MiB', 'unknown', '512 MiB'])
})
