import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

// Minimal DOM double. Every element exposes querySelectorAll() returning [] so
// the client script can probe nodes without the fake tree throwing (see #63).
class Element {
  innerHTML = ''
  value = ''
  className = ''
  onchange = () => {}
  querySelectorAll() {
    return []
  }
  set textContent(value: unknown) {
    this.innerHTML = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  get textContent() {
    return this.innerHTML
  }
}

test('ticket filter composes with repository, activity and event-type filters', async () => {
  const server = express().use(dashboardRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    const { port } = server.address() as { port: number }
    html = await (await fetch(`http://127.0.0.1:${port}/dashboard`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  assert.match(html, /<label for="ticketFilter">Ticket \(agents and events only\)<\/label>/)

  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const hostile = '\"><script>bad</script>&'
  const snapshot = () => ({
    generatedAt: '2026-11-05T07:00:00Z',
    liveAgentsCount: 5,
    recentEventsCount: 5,
    liveAgents: [
      { agentId: 'agent-done-t1', repo: 'forge', ticket: 'RAC-1', status: 'done', intent: null, updatedAt: '2026-11-05T07:00:00Z', branch: null },
      { agentId: 'agent-work-t1', repo: 'forge', ticket: 'RAC-1', status: 'editing', intent: null, updatedAt: '2026-11-05T07:00:00Z', branch: null },
      { agentId: 'agent-work-t2', repo: 'brain', ticket: 'RAC-2', status: 'editing', intent: null, updatedAt: '2026-11-05T07:00:00Z', branch: null },
      { agentId: 'agent-untagged', repo: 'forge', ticket: null, status: 'editing', intent: null, updatedAt: '2026-11-05T07:00:00Z', branch: null },
      { agentId: 'agent-hostile', repo: 'forge', ticket: hostile, status: 'editing', intent: null, updatedAt: '2026-11-05T07:00:00Z', branch: null },
    ],
    recentEvents: [
      { id: 1, eventType: 'pr_opened', repo: 'forge', ticket: 'RAC-1', agentId: 'evt-a', createdAt: '2026-11-05T07:00:00Z' },
      { id: 2, eventType: 'pr_merged', repo: 'forge', ticket: 'RAC-1', agentId: 'evt-b', createdAt: '2026-11-05T07:00:00Z' },
      { id: 3, eventType: 'pr_opened', repo: 'brain', ticket: 'RAC-2', agentId: 'evt-c', createdAt: '2026-11-05T07:00:00Z' },
      { id: 4, eventType: 'pr_opened', repo: 'forge', ticket: null, agentId: 'evt-d', createdAt: '2026-11-05T07:00:00Z' },
      { id: 5, eventType: 'forge_dispatched', repo: 'forge', ticket: hostile, agentId: 'evt-e', createdAt: '2026-11-05T07:00:00Z' },
    ],
    liveByRepo: { forge: 4, brain: 1 },
  })
  const next = snapshot()
  let requests = 0
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() },
    Date,
    AbortController,
    fetch: async () => {
      requests++
      return { ok: true, json: async () => next }
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
  })
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  for (let i = 0; i < 20; i++) await Promise.resolve()

  const select = (id: string, value: string) => {
    el(id).value = value
    el(id).onchange()
  }
  const counts = (agents: string, events = agents) => {
    for (const id of ['liveCount', 'liveCount2']) assert.equal(el(id).textContent, agents)
    for (const id of ['eventCount', 'eventCount2']) assert.equal(el(id).textContent, events)
  }

  // No filters: every agent and event is shown.
  counts('5')
  assert.match(el('ticketFilter').innerHTML, /All tickets/)
  assert.match(el('ticketFilter').innerHTML, /RAC-1/)
  assert.match(el('ticketFilter').innerHTML, /RAC-2/)
  // Hostile ticket values are HTML-escaped in the option list, never raw.
  assert.match(el('ticketFilter').innerHTML, /&quot;&gt;&lt;script&gt;/)
  assert.doesNotMatch(el('ticketFilter').innerHTML, /<script>/)

  // Ticket alone narrows agents and events to that ticket.
  select('ticketFilter', 'RAC-1')
  counts('2')
  assert.match(el('agents').innerHTML, /agent-done-t1/)
  assert.match(el('agents').innerHTML, /agent-work-t1/)
  assert.doesNotMatch(el('agents').innerHTML, /agent-work-t2|agent-untagged|agent-hostile/)
  assert.match(el('events').innerHTML, /evt-a/)
  assert.match(el('events').innerHTML, /evt-b/)
  assert.doesNotMatch(el('events').innerHTML, /evt-c|evt-d|evt-e/)
  // Repo pills reflect the ticket-filtered agents only.
  assert.doesNotMatch(el('byRepo').innerHTML, /brain/)

  // Ticket + activity: activity narrows agents (working drops the "done" one)
  // but does not touch events.
  select('activityFilter', 'working')
  counts('1', '2')
  assert.match(el('agents').innerHTML, /agent-work-t1/)
  assert.doesNotMatch(el('agents').innerHTML, /agent-done-t1/)

  // Ticket + activity + eventType: all three compose with AND semantics.
  select('eventTypeFilter', 'pr_opened')
  counts('1', '1')
  assert.match(el('events').innerHTML, /evt-a/)
  assert.doesNotMatch(el('events').innerHTML, /evt-b/)

  // Combining with a repository that excludes the ticket yields an empty set.
  select('repoFilter', 'brain')
  counts('0', '0')
  assert.match(el('agents').innerHTML, /no matching agent checkpoints/)
  assert.match(el('events').innerHTML, /no matching events in recent snapshot/)

  // Clearing every filter restores the full board; all filtering was local.
  select('repoFilter', '')
  select('activityFilter', 'all')
  select('eventTypeFilter', '')
  select('ticketFilter', '')
  counts('5')
  assert.equal(requests, 1)

  // A hostile ticket value selects cleanly and stays escaped in the option list.
  select('ticketFilter', hostile)
  counts('1')
  assert.equal(el('ticketFilter').value, hostile)
  assert.match(el('ticketFilter').innerHTML, /&quot;&gt;&lt;script&gt;/)
  assert.doesNotMatch(el('ticketFilter').innerHTML, /<script>/)
})
