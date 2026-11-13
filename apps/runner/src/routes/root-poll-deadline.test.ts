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
const health = (version: string) => ({ version, acceptingTasks: true })
const tasks = (status: string) => [{ id: 'abcdefgh', repo: '/repo', status }]
type Reply = { ok: boolean; json: () => Promise<unknown> }

for (const endpoint of ['/health', '/tasks?limit=5']) {
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
          url === '/tasks/stats' ? Promise.resolve({ ok: true, json: async () => ({ total: 0, completed: 0, failed: 0, queued: 0, running: 0 }) }) :
          new Promise<Reply>(resolve => requests.push({ url, signal: options.signal, resolve })),
        setTimeout: (callback: () => void, ms: number) => {
          timers.set(++timerId, { at: now + ms, callback }); return timerId
        },
        clearTimeout: (id: number) => timers.delete(id),
      })
      await flush()
      const payload = (url: string, value: string) => url === '/health' ? health(value) : tasks(value)
      const complete = (request: typeof requests[number], value: string) =>
        request.resolve({ ok: true, json: async () => payload(request.url, value) })
      // Seed both sections so timeout must retain successful values.
      requests.forEach(r => complete(r, 'seed'))
      await flush()
      await advance(5000)
      const hung = requests.find((r, i) => i >= 2 && r.url === endpoint)!
      let resolveBody!: (value: unknown) => void
      if (phase === 'body') {
        hung.resolve({ ok: true, json: () => new Promise(resolve => { resolveBody = resolve }) })
      }
      requests.filter((r, i) => i >= 2 && r !== hung).forEach(r => complete(r, 'healthy-1'))
      await flush()
      await advance(9999)
      assert.equal(hung.signal.aborted, false)
      await advance(1)
      assert.equal(hung.signal.aborted, true)
      const freshness = endpoint === '/health' ? 'health-freshness' : 'tasks-freshness'
      const valueId = endpoint === '/health' ? 'live-version' : 'recent-tasks'
      const healthyId = endpoint === '/health' ? 'recent-tasks' : 'live-version'
      assert.match(el(freshness).textContent, /stale/)
      assert.match(el(valueId).textContent, /seed/)
      for (let i = 0; i < 4; i++) {
        const count = requests.length
        await advance(5000)
        assert.equal(requests.length, count + 1)
        const request = requests.at(-1)!
        assert.notEqual(request.url, endpoint)
        complete(request, `healthy-${i + 2}`)
        await flush()
        assert.match(el(healthyId).textContent, new RegExp(`healthy-${i + 2}`))
      }
      // An abort-ignoring completion cannot clear stale state or publish old data.
      if (phase === 'body') resolveBody(payload(endpoint, 'obsolete'))
      else complete(hung, 'obsolete')
      await flush()
      assert.match(el(freshness).textContent, /stale/)
      assert.match(el(valueId).textContent, /seed/)
      const count = requests.length
      await advance(5000)
      assert.equal(requests.length, count + 2)
      requests.slice(count).forEach(r => complete(r, 'recovered'))
      await flush()
      assert.equal(el(freshness).textContent, '')
      assert.match(el(valueId).textContent, /recovered/)
      assert.equal(timers.size, 1)
    })
  }
}
