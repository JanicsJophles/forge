import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

class Element {
  querySelectorAll() { return [] }
  innerHTML = ''
  value = ''
  className = ''
  onchange = () => {}
  set textContent(value: unknown) {
    this.innerHTML = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  get textContent() { return this.innerHTML }
}

test('event details are escaped formatted text and retain disclosure state only within the snapshot', async () => {
  const server = express().use(dashboardRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    const { port } = server.address() as { port: number }
    html = await (await fetch(`http://127.0.0.1:${port}/dashboard`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  assert.match(html, /section \{\s*min-width: 0/)
  assert.match(html, /\.event-details pre \{ white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%/)
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const details = {
    title: '</pre><script>alert("quotes")</script>&',
    evidence: { passed: true, counts: [1, null, 'quoted "value"'] },
    long: 'x'.repeat(10000),
  }
  const event = (id: number, repo: string, value?: unknown) => ({ id, repo, eventType: 'forge_dispatched', details: value })
  const events = [event(1, 'forge', details), event(2, 'brain', { ci: 'passed' }), event(3, 'forge'), event(4, 'forge', {}), event(5, 'forge', null)]
  let next = {
    generatedAt: '2026-11-05T07:00:00Z', liveAgentsCount: 0, recentEventsCount: events.length,
    liveAgents: [], liveByRepo: {}, recentEvents: events,
  }
  let offline = false
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() },
    Date, AbortController,
    fetch: async () => { if (offline) throw new Error('offline'); return { ok: true, json: async () => next } },
    setTimeout: () => 1, clearTimeout: () => {},
  })
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  const rendered = () => el('events').innerHTML
  assert.equal((rendered().match(/<details /g) || []).length, 2)
  assert.match(rendered(), /<summary>Event details<\/summary><pre>\{\n  "title":/)
  assert.match(rendered(), /&lt;\/pre&gt;&lt;script&gt;/)
  assert.doesNotMatch(rendered(), /<script>|<details[^>]* open/)
  assert.ok(rendered().includes('x'.repeat(10000)))
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  assert.deepEqual(JSON.parse(decode(rendered().match(/<pre>([\s\S]*?)<\/pre>/)![1])), details)
  const toggle = (id: number, open: boolean, connected = true) => vm.runInContext(
    `rememberEventDetails({ dataset: { eventId: '${id}' }, open: ${open}, isConnected: ${connected} })`, context)
  const isOpen = (id: number) => new RegExp(`data-event-id="${id}"[^>]* open>`).test(rendered())
  const select = (repo: string) => { el('repoFilter').value = repo; el('repoFilter').onchange() }
  toggle(1, true)
  await vm.runInContext('refresh()', context)
  assert.ok(isOpen(1), 'poll preserves open event')
  toggle(1, false, false)
  select('brain')
  toggle(2, true)
  select('forge')
  assert.ok(isOpen(1), 'filter preserves hidden event state')
  select('')
  assert.ok(isOpen(2))
  toggle(1, false)
  select('')
  assert.ok(!isOpen(1), 'closing is remembered')
  toggle(1, true)
  offline = true
  const before = rendered()
  await vm.runInContext('refresh()', context)
  assert.equal(rendered(), before, 'stale poll preserves board')
  assert.match(el('connection').textContent, /^Stale/)
  offline = false
  next = { ...next, recentEvents: [events[1]], recentEventsCount: 1 }
  select('brain')
  await vm.runInContext('refresh()', context)
  next = { ...next, recentEvents: events, recentEventsCount: events.length }
  await vm.runInContext('refresh()', context)
  select('')
  assert.ok(!isOpen(1), 'event removed while filtered discards state')
  assert.ok(isOpen(2), 'retained event keeps state')
})
