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
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join('') }
  appendChild(child: Element) { this.children.push(child) }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('malformed task polls preserve exact rows, independent health, and recover including empty history', async () => {
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
  const valid = { id: 'saved-task', status: 'completed', repo: '/opt/repos/<forge>', prompt: '<saved>' }
  let payload: unknown = [null]
  let healthReads = 0
  const timers: (() => void)[] = []
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById: el, createElement: () => new Element() },
    AbortController, clearTimeout: () => {},
    setTimeout: (callback: () => void, delay: number) => { if (delay === 5000) timers.push(callback) },
    fetch: async (url: string) => ({ ok: true, json: async () => {
      if (url === '/tasks?limit=5') return payload
      if (url === '/tasks/stats') return { total: 1, queued: 0, running: 0, completed: 1, failed: 0 }
      healthReads++
      return { acceptingTasks: true, queuedOrRunning: healthReads, maxConcurrentTasks: 100 }
    } }),
  })
  await flush()
  assert.match(el('tasks-freshness').textContent, /unavailable/)
  assert.equal(el('recent-tasks').children.length, 0)
  const poll = async (value: unknown) => {
    payload = value
    assert.equal(timers.length, 1)
    timers.shift()!()
    await flush()
  }
  const malformed = [null, {}, 42, 'row', false, [], { status: 'queued' },
    ...['', '   ', '.', '..', '\ud800', 4].map(id => ({ ...valid, id })),
    ...[undefined, null, 'unknown', '<b>running</b>', 1].map(status => ({ ...valid, status })),
    ...['repo', 'branch', 'prompt', 'createdAt', 'startedAt', 'completedAt', 'provider']
      .map(key => ({ ...valid, [key]: {} })),
    ...['yes', 1, {}].map(promptTruncated => ({ ...valid, promptTruncated })),
    ...[-1, 1.5, '10', Infinity].map(promptBytes => ({ ...valid, promptBytes }))]
  for (const row of malformed) {
    await poll([row])
    assert.match(el('tasks-freshness').textContent, /unavailable/)
  }
  await poll([valid])
  const saved = el('recent-tasks').children.slice()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].textContent, 'saved-ta — <forge> — completed — <saved> — Task ID: saved-task — Repository: /opt/repos/<forge>\nSaved provider: not recorded — Saved model: provider default / not recorded — Auto-commit requested: not recorded View logs Changes')
  assert.equal(el('tasks-freshness').textContent, '')
  for (const row of malformed) {
    const before = healthReads
    await poll([valid, row])
    assert.match(el('tasks-freshness').textContent, /stale/)
    assert.deepEqual(el('recent-tasks').children, saved)
    assert.equal(el('recent-tasks').children[0], saved[0])
    assert.equal(healthReads, before + 1)
    assert.equal(el('health-freshness').textContent, '')
  }
  await poll([])
  assert.equal(el('recent-tasks').textContent, 'No recent tasks')
  assert.equal(el('tasks-freshness').textContent, '')
  const empty = el('recent-tasks').children[0]
  await poll([{}])
  assert.equal(el('recent-tasks').children[0], empty)
  assert.match(el('tasks-freshness').textContent, /stale/)
  for (const status of ['queued', 'running', 'completed', 'failed']) {
    await poll([{ ...valid, status, promptTruncated: false, promptBytes: 0 }])
    assert.equal(el('tasks-freshness').textContent, '')
    assert.match(el('recent-tasks').textContent, new RegExp(status))
  }
  await poll([...Array(5).fill(valid), null])
  assert.equal(el('recent-tasks').children.length, 5, 'only bounded displayed rows are validated')
})
