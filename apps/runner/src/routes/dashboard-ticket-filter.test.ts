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
  querySelectorAll() { return [] }
  private text = ''
  set textContent(value: unknown) {
    this.text = String(value)
    this.innerHTML = this.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  get textContent() { return this.text }
}

test('ticket selection combines locally with repository and survives absence and failed polling', async () => {
  const app = express().use(dashboardRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    const address = server.address() as { port: number }
    html = await (await fetch(`http://127.0.0.1:${address.port}/dashboard`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  assert.match(html, /Ticket \(agents and events only\)/)
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const hostile = '\"><script>bad</script>&'
  const snapshot = () => ({
    generatedAt: '2026-11-05T07:00:00Z', liveAgentsCount: 4, recentEventsCount: 4,
    liveAgents: [
      { agentId: 'chosen-agent', repo: 'forge', ticket: hostile },
      { agentId: 'cross-repo-agent', repo: 'brain', ticket: hostile },
      { agentId: 'prototype-agent', repo: 'forge', ticket: '__proto__' },
      { agentId: 'unticketed-agent', repo: 'forge', ticket: null },
    ],
    recentEvents: [
      { eventType: 'chosen_event', repo: 'forge', ticket: hostile },
      { eventType: 'cross_repo_event', repo: 'brain', ticket: hostile },
      { eventType: 'prototype_event', repo: 'forge', ticket: '__proto__' },
      { eventType: 'event_only', repo: 'brain', ticket: 'EVENT-ONLY' },
    ],
    liveByRepo: { forge: 3, brain: 1 },
  })
  let next = snapshot()
  let failed = false
  let requests = 0
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() },
    Date, AbortController,
    fetch: async () => { requests++; if (failed) throw new Error('offline'); return { ok: true, json: async () => next } },
    setTimeout: () => 1, clearTimeout: () => {},
  })
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  await settle()
  const select = (id: string, value: string) => { el(id).value = value; el(id).onchange() }
  const counts = (agents: string, events = agents) => {
    for (const id of ['liveCount', 'liveCount2']) assert.equal(el(id).textContent, agents)
    for (const id of ['eventCount', 'eventCount2']) assert.equal(el(id).textContent, events)
  }
  counts('4')
  assert.match(el('ticketFilter').innerHTML, /All tickets/)
  assert.match(el('ticketFilter').innerHTML, /&quot;&gt;&lt;script&gt;/)
  assert.ok(!el('ticketFilter').innerHTML.includes('<script>'))
  select('repoFilter', 'forge')
  // Choices come from the full snapshot, including events outside this repository.
  assert.match(el('ticketFilter').innerHTML, /EVENT-ONLY/)
  select('ticketFilter', hostile)
  counts('1')
  assert.match(el('agents').innerHTML, /chosen-agent/)
  assert.doesNotMatch(el('agents').innerHTML, /cross-repo-agent|prototype-agent|unticketed-agent/)
  assert.doesNotMatch(el('events').innerHTML, /cross_repo_event|prototype_event|event_only/)
  assert.doesNotMatch(el('byRepo').innerHTML, /brain/)
  select('repoFilter', '')
  counts('2')
  select('ticketFilter', '__proto__')
  counts('1')
  assert.match(el('agents').innerHTML, /prototype-agent/)
  assert.match(el('events').innerHTML, /prototype_event/)
  assert.equal(requests, 1)
  select('ticketFilter', hostile)
  next = { ...snapshot(), liveAgents: [], recentEvents: [], liveAgentsCount: 0, recentEventsCount: 0, liveByRepo: { forge: 0, brain: 0 } }
  await vm.runInContext('refresh()', context)
  assert.equal(el('ticketFilter').value, hostile)
  assert.match(el('ticketFilter').innerHTML, /&quot;&gt;&lt;script&gt;/)
  counts('0')
  assert.match(el('agents').innerHTML, /no matching live agents/)
  assert.match(el('events').innerHTML, /no matching events/)
  failed = true
  await vm.runInContext('refresh()', context)
  assert.equal(el('ticketFilter').value, hostile)
  assert.match(el('connection').textContent, /^Stale/)
  failed = false
  next = snapshot()
  await vm.runInContext('refresh()', context)
  counts('2')
  assert.equal(el('ticketFilter').value, hostile)
  failed = true
  await vm.runInContext('refresh()', context)
  select('repoFilter', 'forge')
  counts('1')
  select('ticketFilter', '')
  counts('3', '2')
  assert.match(el('connection').textContent, /^Stale/)
  assert.equal(requests, 5)
})
