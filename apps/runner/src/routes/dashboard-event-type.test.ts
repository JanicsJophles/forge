import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

class Element {
  innerHTML = ''
  value = ''
  className = ''
  onchange = () => {}
  set textContent(value: unknown) {
    this.innerHTML = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  get textContent() { return this.innerHTML }
}

test('event types filter the cached snapshot and preserve disclosure state and stale status', async () => {
  const server = express().use(dashboardRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    const { port } = server.address() as { port: number }
    html = await (await fetch(`http://127.0.0.1:${port}/dashboard`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  assert.match(html, /<label for="eventTypeFilter">Event type<\/label>/)
  assert.match(html, /events shown \(recent snapshot\)/)
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const hostile = '\"><script>bad</script>&'
  const events = [
    { id: 1, eventType: 'forge_failed', repo: 'forge', details: { reason: 'failed' } },
    { id: 2, eventType: 'forge_failed', repo: 'brain' },
    { id: 3, eventType: 'pr_ci_failed', repo: 'forge' },
    { id: 4, eventType: hostile, repo: 'brain' },
  ]
  let next = {
    generatedAt: '2026-11-05T07:00:00Z', liveAgentsCount: 1, recentEventsCount: 99,
    liveAgents: [{ agentId: 'agent', repo: 'forge' }], liveByRepo: { forge: 1 }, recentEvents: events,
  }
  let requests = 0
  let offline = false
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() }, Date, AbortController,
    fetch: async () => { requests++; if (offline) throw new Error('offline'); return { ok: true, json: async () => next } },
    setTimeout: () => 1, clearTimeout: () => {},
  })
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  const select = (id: string, value: string) => { el(id).value = value; el(id).onchange() }
  const count = (value: string) => {
    for (const id of ['eventCount', 'eventCount2']) assert.equal(el(id).textContent, value)
  }
  count('4')
  vm.runInContext("rememberEventDetails({ dataset: { eventId: '1' }, open: true, isConnected: true })", context)
  select('eventTypeFilter', 'pr_ci_failed')
  count('1')
  assert.doesNotMatch(el('events').innerHTML, /forge_failed/)
  select('eventTypeFilter', 'forge_failed')
  count('2')
  assert.match(el('events').innerHTML, /data-event-id="1"[^>]* open>/)
  select('repoFilter', 'forge')
  count('1')
  assert.match(el('eventTypeFilter').innerHTML, /&quot;&gt;&lt;script&gt;/)
  assert.doesNotMatch(el('eventTypeFilter').innerHTML, /<script>/)
  select('eventTypeFilter', hostile)
  count('0')
  assert.match(el('events').innerHTML, /no matching events in recent snapshot/)
  assert.equal(el('liveCount').textContent, '1')
  select('repoFilter', '')
  count('1')
  assert.match(el('events').innerHTML, /&lt;script&gt;/)
  assert.equal(requests, 1)
  next = { ...next, recentEvents: events.slice(0, 3) }
  await vm.runInContext('refresh()', context)
  assert.equal(el('eventTypeFilter').value, hostile)
  assert.match(el('eventTypeFilter').innerHTML, /&quot;&gt;&lt;script&gt;/)
  count('0')
  offline = true
  await vm.runInContext('refresh()', context)
  select('eventTypeFilter', '')
  count('3')
  assert.match(el('connection').textContent, /^Stale/)
  assert.match(el('events').innerHTML, /data-event-id="1"[^>]* open>/)
  assert.equal(requests, 3)
  offline = false
  next = { ...next, recentEvents: events }
  select('eventTypeFilter', hostile)
  await vm.runInContext('refresh()', context)
  count('1')
  assert.equal(el('eventTypeFilter').value, hostile)
})
