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
  private text = ''
  set textContent(value: unknown) {
    this.text = String(value)
    this.innerHTML = this.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  get textContent() { return this.text }
}

test('repository selection uses the latest cached snapshot through absence, failure and recovery', async () => {
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
  assert.match(html, /<label for="repoFilter">Repository<\/label>/)
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const hostile = '\"><script>bad</script>&'
  const snapshot = (repo = hostile) => ({
    generatedAt: '2026-11-05T07:00:00Z', liveAgentsCount: 2, recentEventsCount: 2,
    liveAgents: [{ agentId: 'chosen-agent', repo }, { agentId: 'other-agent', repo: 'brain' }],
    recentEvents: [{ eventType: 'chosen_event', repo }, { eventType: 'other_event', repo: 'brain' }],
    liveByRepo: { [repo]: 1, brain: 1 },
  })
  let next: unknown = snapshot()
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
  const select = (repo: string) => { el('repoFilter').value = repo; el('repoFilter').onchange() }
  assert.match(el('repoFilter').innerHTML, /All repositories/)
  assert.ok(!el('repoFilter').innerHTML.includes('<script>'))
  assert.match(el('repoFilter').innerHTML, /&quot;&gt;&lt;script&gt;/)
  select(hostile)
  assert.equal(requests, 1)
  assert.match(el('agents').innerHTML, /chosen-agent/)
  assert.doesNotMatch(el('agents').innerHTML, /other-agent/)
  assert.doesNotMatch(el('events').innerHTML, /other_event/)
  for (const id of ['liveCount', 'liveCount2', 'eventCount', 'eventCount2']) assert.equal(el(id).textContent, '1')
  next = snapshot('forge')
  await vm.runInContext('refresh()', context)
  assert.equal(el('repoFilter').value, hostile)
  assert.match(el('agents').innerHTML, /no matching agent checkpoints/)
  assert.match(el('events').innerHTML, /no matching events/)
  assert.equal(el('liveCount').textContent, '0')
  assert.ok(el('repoFilter').innerHTML.includes('&lt;script&gt;'))
  failed = true
  await vm.runInContext('refresh()', context)
  select('brain')
  assert.match(el('agents').innerHTML, /other-agent/)
  assert.match(el('connection').textContent, /^Stale/)
  assert.equal(requests, 3)
  select('')
  assert.equal(el('liveCount').textContent, '2')
  assert.match(el('events').innerHTML, /chosen_event/)
  failed = false
  next = snapshot()
  select(hostile)
  await vm.runInContext('refresh()', context)
  assert.equal(el('repoFilter').value, hostile)
  assert.match(el('agents').innerHTML, /chosen-agent/)
  assert.match(el('connection').textContent, /^Connected/)
})
