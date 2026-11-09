import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { rootRouter } from './root.js'
import type { AddressInfo } from 'node:net'

class Element {
  private text = ''
  children: Element[] = []
  set textContent(value: string) { this.text = value; this.children = [] }
  get textContent() { return this.text + this.children.map(child => child.textContent).join('') }
  appendChild(child: Element) { this.children.push(child) }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('landing refresh serializes cycles, updates independently, and recovers without losing data', async () => {
  const app = express().use(rootRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    html = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML/)
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  type Reply = { ok: boolean; json: () => Promise<unknown> }
  const requests: { url: string; resolve: (reply: Reply) => void; reject: (error: Error) => void }[] = []
  const timers: (() => void)[] = []
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById: el, createElement: () => new Element() },
    fetch: (url: string, options: { cache: string }) => {
      assert.equal(options.cache, 'no-store')
      return new Promise<Reply>((resolve, reject) => requests.push({ url, resolve, reject }))
    },
    setTimeout: (callback: () => void, delay: number) => {
      assert.equal(delay, 5000)
      timers.push(callback)
    },
  })
  const reply = (index: number, value: unknown, ok = true) =>
    requests[index].resolve({ ok, json: async () => value })
  const health = (used: number) => ({ acceptingTasks: used === 0, queuedOrRunning: used,
    maxConcurrentTasks: 2, notAcceptingReason: 'concurrency', uptimeSeconds: 60, version: '<b>v</b>' })
  const tasks = (status: string) => Array.from({ length: 6 }, () => ({
    id: '12345678-abcd', repo: '/opt/repos/<img>', status,
  }))
  assert.deepEqual(requests.map(r => r.url), ['/tasks?limit=5', '/health'])
  // An initial failed endpoint does not suppress the successful one.
  requests[0].reject(new Error('offline'))
  reply(1, health(0))
  await flush()
  assert.match(el('tasks-freshness').textContent, /unavailable/)
  assert.equal(el('accepting').textContent, 'yes')
  assert.equal(timers.length, 1)
  timers.shift()!()
  reply(2, tasks('<b>running</b>'))
  await flush()
  assert.equal(el('recent-tasks').children.length, 5)
  assert.equal(el('recent-tasks').children[0].textContent, '12345678 — <img> — <b>running</b>')
  assert.equal(el('tasks-freshness').textContent, '')
  // Health is slow: there is no timer or new request until it settles.
  assert.equal(timers.length, 0)
  await flush()
  assert.equal(requests.length, 4)
  reply(3, health(2))
  await flush()
  assert.equal(el('slots').textContent, '2 / 2')
  assert.equal(el('accepting').textContent, 'no (at capacity)')
  timers.shift()!()
  reply(4, [], false)
  requests[5].reject(new Error('offline'))
  await flush()
  assert.match(el('tasks-freshness').textContent, /stale/)
  assert.match(el('health-freshness').textContent, /stale/)
  assert.equal(el('recent-tasks').children.length, 5)
  assert.equal(el('slots').textContent, '2 / 2')
  timers.shift()!()
  reply(6, tasks('completed'))
  reply(7, health(0))
  await flush()
  assert.equal(el('tasks-freshness').textContent, '')
  assert.equal(el('health-freshness').textContent, '')
  assert.match(el('recent-tasks').textContent, /completed/)
  assert.equal(el('slots').textContent, '0 / 2')
  // The reverse partial failure also permits task updates.
  timers.shift()!()
  reply(8, [])
  reply(9, null)
  await flush()
  assert.equal(el('recent-tasks').textContent, 'No recent tasks')
  assert.match(el('health-freshness').textContent, /stale/)
  assert.equal(timers.length, 1)
})
