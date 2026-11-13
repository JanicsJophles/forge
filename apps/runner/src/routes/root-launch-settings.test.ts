import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { rootRouter } from './root.js'

// Model textContent replacement and native anchors without an HTML parser.
class Element {
  private text = ''
  children: Element[] = []
  href?: string
  constructor(readonly tag: string) {}
  set textContent(value: string) { this.text = value; this.children = [] }
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join('') }
  appendChild(child: Element) { this.children.push(child) }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('recent saved launch settings are bounded inert text and malformed polls retain all rows', async () => {
  const server = express().use(rootRouter).listen(0, '127.0.0.1')
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
    if (!elements.has(id)) elements.set(id, new Element('span'))
    return elements.get(id)!
  }
  const hostile = '<img src=x onerror=alert(1)><script>evil()</script>'
  let payload: unknown[] = [
    { id: 'claude-default', status: 'completed', provider: 'claude', autoCommit: false },
    { id: 'codex-custom', status: 'running', provider: 'codex', model: 'gpt-custom', autoCommit: true },
    { id: 'legacy', status: 'queued' },
    { id: 'hostile', status: 'failed', provider: hostile, model: hostile, errorMessage: 'failure' },
    { id: 'long', status: 'completed', provider: '🧠'.repeat(101), model: '🧠'.repeat(100) + 'hidden' },
  ]
  const requests: string[] = []
  const timers: (() => void)[] = []
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById: el, createElement: (tag: string) => {
      assert.ok(['li', 'a'].includes(tag))
      return new Element(tag)
    } },
    AbortController, clearTimeout: () => {},
    setTimeout: (callback: () => void, delay: number) => { if (delay === 5000) timers.push(callback) },
    fetch: async (url: string) => {
      requests.push(url)
      return { ok: true, json: async () => url === '/tasks?limit=5' ? payload : url === '/health' ?
        { acceptingTasks: true, queuedOrRunning: 1, maxConcurrentTasks: 2 } :
        { total: 5, completed: 2, failed: 1, queued: 1, running: 1 } }
    },
  })
  await flush()
  const rows = el('recent-tasks').children.slice()
  assert.equal(rows.length, 5)
  assert.match(rows[0].textContent, /Saved provider: claude — Saved model: provider default \/ not recorded — Auto-commit requested: no/)
  assert.match(rows[1].textContent, /Saved provider: codex — Saved model: gpt-custom — Auto-commit requested: yes/)
  assert.match(rows[2].textContent, /Saved provider: not recorded — Saved model: provider default \/ not recorded — Auto-commit requested: not recorded/)
  assert.ok(rows[3].textContent.includes('Saved provider: ' + hostile + ' — Saved model: ' + hostile))
  assert.match(rows[3].textContent, /Failure reason: failure/)
  assert.ok(rows[4].textContent.includes('Saved provider: ' + '🧠'.repeat(100) + '… [Further setting text omitted]'))
  assert.ok(rows[4].textContent.includes('Saved model: ' + '🧠'.repeat(100) + '… [Further setting text omitted]'))
  assert.doesNotMatch(rows[4].textContent, /hidden/)
  assert.ok(rows.every(row => row.children.every(child => child.tag === 'a')))
  for (const invalid of [
    { model: 42 }, { model: false }, { model: {} }, { model: [] },
    { autoCommit: 'false' }, { autoCommit: 0 }, { autoCommit: {} }, { autoCommit: [] },
  ]) {
    payload = [{ id: 'replacement', status: 'completed' }, { id: 'bad', status: 'failed', ...invalid }]
    timers.shift()!()
    await flush()
    assert.deepEqual(el('recent-tasks').children, rows)
    assert.match(el('tasks-freshness').textContent, /stale/)
    assert.equal(el('health-freshness').textContent, '')
    assert.equal(el('totals-freshness').textContent, '')
  }
  payload = [{ id: 'refreshed', status: 'completed', provider: 'claude', model: 'x'.repeat(100), autoCommit: false }]
  timers.shift()!()
  await flush()
  assert.equal(el('recent-tasks').children.length, 1)
  assert.ok(el('recent-tasks').children[0].textContent.includes('Saved model: ' + 'x'.repeat(100)))
  assert.doesNotMatch(el('recent-tasks').textContent, /omitted/)
  assert.equal(el('tasks-freshness').textContent, '')
  assert.equal(requests.length, 30)
  assert.ok(requests.every(url => ['/tasks?limit=5', '/health', '/tasks/stats'].includes(url)))
})
