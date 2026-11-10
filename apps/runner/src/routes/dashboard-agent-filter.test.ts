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

test('exact agent identity composes with board filters and survives polling', async () => {
  const server = express().use(dashboardRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    const { port } = server.address() as { port: number }
    html = await (await fetch(`http://127.0.0.1:${port}/dashboard`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  assert.match(html, /Agent \(checkpoints and events only\)/)
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const hostile = '\"><script>bad</script>&'
  const agent = (agentId: string, status = 'editing') => ({
    agentId, status, repo: 'forge', ticket: 'RAC-1', updatedAt: '2026-11-10T09:00:00Z',
  })
  const event = (id: number, agentId?: string, eventType = 'pr_opened', repo = 'forge', ticket = 'RAC-1') => ({
    id, agentId, eventType, repo, ticket, createdAt: '2026-11-10T09:00:00Z',
  })
  const next = {
    generatedAt: '2026-11-10T09:00:00Z',
    liveAgentsCount: 3, recentEventsCount: 8,
    liveAgents: [agent('worker'), agent('worker-extra', 'done'), agent(hostile)],
    recentEvents: [event(1, 'worker'), event(2, 'worker-extra'), event(3, 'historical'),
      event(4), event(5, hostile), event(6, 'worker', 'pr_merged'),
      event(7, 'worker', 'pr_opened', 'brain'), event(8, 'worker', 'pr_opened', 'forge', 'RAC-2')],
    liveByRepo: { forge: 3 },
    liveTasks: [{ id: 'task-independent', repo: 'forge', status: 'running', createdAt: '2026-11-10T09:00:00Z' }],
    capacity: { activeTasks: 1, maxConcurrentTasks: 4, availableSlots: 3 },
  }
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() },
    Date, AbortController,
    fetch: async () => ({ ok: true, json: async () => next }),
    setTimeout: () => 1, clearTimeout: () => {},
  })
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  await flush()
  const select = (id: string, value: string) => { el(id).value = value; el(id).onchange() }
  const counts = (agents: number, events: number) => {
    for (const id of ['liveCount', 'liveCount2']) assert.equal(el(id).textContent, String(agents))
    for (const id of ['eventCount', 'eventCount2']) assert.equal(el(id).textContent, String(events))
  }
  counts(3, 8)
  assert.match(el('agentFilter').innerHTML, /historical/)
  assert.match(el('agentFilter').innerHTML, /&quot;&gt;&lt;script&gt;/)
  assert.doesNotMatch(el('agentFilter').innerHTML, /<script>|undefined/)
  select('agentFilter', 'worker')
  counts(1, 4)
  assert.doesNotMatch(el('agents').innerHTML, /worker-extra/)
  assert.doesNotMatch(el('events').innerHTML, /worker-extra|historical/)
  assert.equal(el('taskCount2').textContent, '1')
  const capacity = el('capacity').textContent
  select('repoFilter', 'forge')
  counts(1, 3)
  select('ticketFilter', 'RAC-1')
  counts(1, 2)
  select('eventTypeFilter', 'pr_opened')
  counts(1, 1)
  select('activityFilter', 'finished')
  counts(0, 1)
  select('activityFilter', 'working')
  counts(1, 1)
  assert.equal(el('capacity').textContent, capacity)
  select('repoFilter', '')
  select('ticketFilter', '')
  select('eventTypeFilter', '')
  select('activityFilter', 'all')
  select('agentFilter', 'historical')
  counts(0, 1)
  select('agentFilter', hostile)
  counts(1, 1)
  assert.doesNotMatch(el('agents').innerHTML, /<script>/)
  assert.doesNotMatch(el('events').innerHTML, /<script>/)
  next.liveAgents = []
  next.recentEvents = []
  vm.runInContext('refresh()', context)
  await flush()
  counts(0, 0)
  assert.equal(el('agentFilter').value, hostile)
  assert.match(el('agentFilter').innerHTML, /&quot;&gt;&lt;script&gt;/)
  next.liveAgents = [agent('worker'), agent('worker-extra')]
  next.recentEvents = [event(1, 'worker'), event(2, 'worker-extra'), event(4)]
  vm.runInContext('refresh()', context)
  await flush()
  counts(0, 0)
  assert.equal(el('agentFilter').value, hostile)
  select('agentFilter', '')
  counts(2, 3)
  assert.equal(el('taskCount2').textContent, '1')
  assert.equal(el('capacity').textContent, capacity)
})
