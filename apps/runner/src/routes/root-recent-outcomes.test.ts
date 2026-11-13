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

test('recent outcomes bound inert diagnostics and preserve rows on malformed polls', async () => {
  const server = express().use(rootRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    html = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML/)
  assert.match(html, /white-space: pre-wrap/)
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element('span'))
    return elements.get(id)!
  }
  const hostile = '<img src=x onerror=alert(1)>\n<script>evil()</script>'
  const long = '🧠'.repeat(499) + 'Z' + '🧠omitted'
  let payload: unknown[] = [
    { id: '../x/"<img>?q=#%🧠', repo: '/full/path/forge', status: 'failed', errorMessage: hostile, prompt: 'fix it' },
    { id: 'long', status: 'failed', errorMessage: long },
    { id: 'missing', status: 'failed' },
    { id: 'empty', status: 'failed', errorMessage: ' \n ' },
    { id: 'active', status: 'running', errorMessage: 'not displayed' },
    { id: 'outside-bound', errorMessage: {} },
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
      return { ok: true, json: async () => url === '/tasks?limit=5' ? payload : url === '/health' ? {} :
        { total: 5, completed: 0, failed: 4, queued: 0, running: 1 } }
    },
  })
  await flush()
  const rows = el('recent-tasks').children.slice()
  assert.equal(rows.length, 5)
  assert.ok(rows[0].textContent.includes('Failure reason: ' + hostile))
  assert.ok(rows[0].textContent.includes('fix it — Task ID: ../x/"<img>?q=#%🧠 — Repository: /full/path/forge'))
  assert.ok(rows[1].textContent.includes('Failure reason: ' + '🧠'.repeat(499) + 'Z\n[Further failure details omitted]'))
  assert.ok(!rows[1].textContent.includes('🧠omitted'))
  assert.match(rows[2].textContent, /Failure reason: Unavailable/)
  assert.match(rows[3].textContent, /Failure reason: Unavailable/)
  assert.doesNotMatch(rows[4].textContent, /Failure reason|not displayed/)
  for (const [index, row] of rows.entries()) {
    const id = (payload[index] as { id: string }).id
    assert.deepEqual(row.children.map(c => [c.tag, c.textContent.trim(), c.href]), [
      ['a', 'View logs', '/tasks/' + encodeURIComponent(id) + '/log/view'],
      ['a', 'Changes', '/tasks/' + encodeURIComponent(id) + '/changes/view'],
    ])
  }
  for (const errorMessage of [42, false, {}, [], ['error']]) {
    payload = [{ id: 'replacement', status: 'completed' }, { id: 'bad', status: 'failed', errorMessage }]
    timers.shift()!()
    await flush()
    assert.deepEqual(el('recent-tasks').children, rows)
    assert.match(el('tasks-freshness').textContent, /stale/)
    assert.doesNotMatch(el('health-freshness').textContent, /stale/)
    assert.doesNotMatch(el('totals-freshness').textContent, /stale/)
  }
  payload = [{ id: 'boundary', status: 'failed', errorMessage: '🧠'.repeat(500) }]
  timers.shift()!()
  await flush()
  assert.ok(el('recent-tasks').children[0].textContent.includes('Failure reason: ' + '🧠'.repeat(500)))
  assert.doesNotMatch(el('recent-tasks').children[0].textContent, /omitted/)
  assert.equal(el('tasks-freshness').textContent, '')
  assert.ok(requests.every(url => ['/tasks?limit=5', '/health', '/tasks/stats'].includes(url)))
})
