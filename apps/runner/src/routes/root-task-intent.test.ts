import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { rootRouter } from './root.js'

class Element {
  private text = ''
  children: Element[] = []
  href?: string
  constructor(readonly tag = 'span') {}
  set textContent(value: string) { this.text = value; this.children = [] }
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join('') }
  appendChild(child: Element) { this.children.push(child) }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('recent saved intent is bounded Unicode text with full identities and survives failed refreshes', async () => {
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
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const payload = [
    { id: 'same-id-one', repo: '/first/forge', status: 'completed', prompt: ' \n Build\t this  page ' },
    { id: 'same-id-two', repo: '/second/forge', status: 'failed', prompt: '🧠'.repeat(161) },
    { id: 'markup', repo: '/<img>/forge', prompt: '<script>alert(1)</script>', promptTruncated: true },
    { id: '', repo: '', prompt: ' \t\n' },
    { prompt: '🧠'.repeat(160) },
  ]
  const requests: string[] = []
  const timers: (() => void)[] = []
  let failed = false
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById: el, createElement: (tag: string) => {
      assert.ok(['li', 'a'].includes(tag))
      return new Element(tag)
    } },
    AbortController, clearTimeout: () => {},
    setTimeout: (callback: () => void, delay: number) => { if (delay === 5000) timers.push(callback) },
    fetch: async (url: string) => {
      requests.push(url)
      if (failed) throw new Error('offline')
      return { ok: true, json: async () => url === '/tasks?limit=5' ? payload : url === '/tasks/stats' ?
        { total: 5, completed: 1, failed: 1, queued: 0, running: 0 } : {} }
    },
  })
  await flush()
  const rows = el('recent-tasks').children
  assert.equal(rows.length, 5)
  if (html.includes('View logs')) {
    assert.equal(rows[0].children[0].textContent.trim(), 'View logs')
    assert.equal(rows[0].children[0].href, '/tasks/same-id-one/log/view')
  }
  assert.match(rows[0].textContent, /Build this page/)
  assert.match(rows[0].textContent, /Task ID: same-id-one — Repository: \/first\/forge/)
  assert.match(rows[1].textContent, /Task ID: same-id-two — Repository: \/second\/forge/)
  const preview = (row: Element) => row.textContent.split(' — ')[3]
  assert.equal(preview(rows[1]), '🧠'.repeat(159) + '…')
  assert.equal(Array.from(preview(rows[1])).length, 160)
  assert.equal(preview(rows[2]), '<script>alert(1)</script>…')
  assert.ok(rows.every(row => row.children.every(child => child.tag === 'a')))
  assert.match(rows[3].textContent, /Saved prompt unavailable — Task ID: unavailable — Repository: unavailable/)
  assert.equal(preview(rows[4]), '🧠'.repeat(160))
  assert.match(rows[4].textContent, /Task ID: unavailable — Repository: unavailable/)
  failed = true
  timers.shift()!()
  await flush()
  assert.equal(el('recent-tasks').children[0], rows[0])
  assert.match(el('tasks-freshness').textContent, /stale/)
  assert.deepEqual(requests.filter(url => url !== '/tasks/stats'),
    ['/tasks?limit=5', '/health', '/tasks?limit=5', '/health'])
})
