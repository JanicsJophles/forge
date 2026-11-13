import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { rootRouter } from './root.js'

class Element {
  textContent = ''
  appendChild(child: Element) { this.textContent += child.textContent }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const good = { acceptingTasks: false, queuedOrRunning: 0, maxConcurrentTasks: 2,
  notAcceptingReason: 'concurrency', uptimeSeconds: 60, version: 'seed',
  freeDiskMb: 4096, dataFreeDiskMb: 2048, minFreeDiskMb: 512,
  oldestRunningTaskAgeSeconds: 30, taskTimeoutMs: 60000 }
const malformed: unknown[] = [
  {}, null, [], 'health',
  { ...good, acceptingTasks: undefined },
  { ...good, acceptingTasks: null },
  { ...good, acceptingTasks: 1 },
  { ...good, acceptingTasks: 'false' },
  { ...good, acceptingTasks: 'true' },
  ...['queuedOrRunning', 'maxConcurrentTasks'].flatMap(field =>
    [undefined, null, true, '2', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, -Infinity, NaN]
      .map(value => ({ ...good, [field]: value }))),
  { ...good, maxConcurrentTasks: 0 },
]

test('malformed health stays unavailable or stale, preserves the panel and recovers independently', async () => {
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
  let payload: unknown = malformed[0]
  let cycle = 0
  const timers: (() => void)[] = []
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById: el, createElement: () => new Element() },
    AbortController,
    fetch: async (url: string) => ({ ok: true, json: async () => url === '/health'
      ? payload : url === '/tasks/stats'
        ? { total: cycle, completed: cycle, failed: 0, queued: 0, running: 0 } : [{ id: 'abcdefgh', repo: `/repo/cycle-${cycle}`, status: 'running' }] }),
    setTimeout: (callback: () => void, delay: number) => {
      if (delay === 5000) timers.push(callback)
      else assert.equal(delay, 10000)
    },
    clearTimeout: () => {},
  })
  await flush()
  const next = async (value: unknown) => {
    payload = value
    cycle++
    assert.equal(timers.length, 1)
    timers.shift()!()
    await flush()
    assert.match(el('recent-tasks').textContent, new RegExp(`cycle-${cycle}`))
    assert.equal(el('tasks-freshness').textContent, '')
    // Also exercise independent stats polling when composed with the totals panel.
    if (elements.has('total-total')) {
      assert.equal(el('total-total').textContent, String(cycle))
      assert.equal(el('totals-freshness').textContent, '')
    }
  }
  for (const value of malformed) {
    await next(value)
    assert.match(el('health-freshness').textContent, /unavailable/)
    assert.match(el('accepting').textContent, /unknown/)
    assert.equal(el('slots').textContent, 'unknown')
  }
  await next(good)
  assert.equal(el('health-freshness').textContent, '')
  assert.equal(el('accepting').textContent, 'no (at capacity)')
  assert.equal(el('slots').textContent, '0 / 2')
  const panel = ['accepting', 'slots', 'uptime', 'live-version',
    'repo-disk', 'data-disk', 'min-disk', 'oldest-running-age', 'task-timeout']
  assert.ok(panel.every(id => elements.has(id)))
  const saved = panel.map(id => el(id).textContent)
  for (const value of malformed) {
    await next(value)
    assert.match(el('health-freshness').textContent, /stale/)
    assert.deepEqual(panel.map(id => el(id).textContent), saved)
  }
  await next({ ...good, acceptingTasks: true, queuedOrRunning: 1, version: 'recovered' })
  assert.equal(el('health-freshness').textContent, '')
  assert.equal(el('accepting').textContent, 'yes')
  assert.equal(el('slots').textContent, '1 / 2')
  assert.equal(el('live-version').textContent, 'recovered')
})
