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

test('recent task anchors retain outcomes, encode IDs, and replace old links on updates', async () => {
  const server = express().use(rootRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    html = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML/)
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]
  const list = new Element('ul')
  const elements = new Map<string, Element>([['recent-tasks', list]])
  let payload: unknown[] = [
    { id: 'failed-123', repo: '/opt/repos/forge', status: 'failed' },
    { id: '../x/"<img>?q=#%🧠', repo: '/opt/repos/<img>', status: 'running' },
  ]
  const requests: string[] = []
  const timers: (() => void)[] = []
  const context = {
    document: {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, new Element('span'))
        return elements.get(id)!
      },
      createElement: (tag: string) => {
        assert.ok(['li', 'a'].includes(tag))
        return new Element(tag)
      },
    },
    fetch: async (url: string) => {
      requests.push(url)
      return { ok: true, json: async () => url === '/health' ? {} : url === '/tasks/stats'
        ? { total: 0, completed: 0, failed: 0, queued: 0, running: 0 } : payload }
    },
    AbortController,
    clearTimeout: () => {},
    setTimeout: (callback: () => void, delay: number) => {
      if (delay === 5000) timers.push(callback)
      else assert.equal(delay, 10000)
    },
  }
  runInNewContext(script, context)
  await flush()
  assert.deepEqual(requests, ['/tasks?limit=5', '/health', '/tasks/stats'])
  assert.equal(list.children.length, 2)
  for (const [index, task] of (payload as { id: string }[]).entries()) {
    const link = list.children[index].children[0]
    assert.equal(link.tag, 'a', 'native href anchors support keyboard navigation')
    assert.equal(link.textContent.trim(), 'View logs')
    assert.equal(link.href, '/tasks/' + encodeURIComponent(task.id) + '/log/view')
  }
  assert.match(list.children[0].textContent, /forge — failed/)
  assert.match(list.children[1].textContent, /<img> — running/)
  const savedRows = list.children.slice()
  const oldLink = list.children[0].children[0]
  payload = [undefined, 42, '', '   ', '\ud800'].map(id => ({ id, repo: 'forge', status: 'failed' }))
  assert.equal(timers.length, 1)
  timers.shift()!()
  await flush()
  assert.deepEqual(list.children, savedRows)
  assert.equal(list.children[0].children[0], oldLink)
  assert.match(elements.get('tasks-freshness')!.textContent, /stale/)
  assert.deepEqual(requests, ['/tasks?limit=5', '/health', '/tasks/stats', '/tasks?limit=5', '/health', '/tasks/stats'])
  payload = ['.', '..'].map(id => ({ id }))
  assert.equal(timers.length, 1)
  timers.shift()!()
  await flush()
  assert.deepEqual(list.children, savedRows)
  assert.equal(list.children[0].children[0], oldLink)
  payload = [{ id: 'recovered', repo: 'forge', status: 'completed' }]
  timers.shift()!()
  await flush()
  assert.equal(list.children.length, 1)
  assert.equal(list.children[0].children[0].href, '/tasks/recovered/log/view')
  assert.notEqual(list.children[0].children[0], oldLink)
  assert.equal(elements.get('tasks-freshness')!.textContent, '')
})
