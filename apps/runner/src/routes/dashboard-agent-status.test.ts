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

test('activity combines with repository and survives polling failure and status refresh', async () => {
  const server = express().use(dashboardRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    const { port } = server.address() as { port: number }
    html = await (await fetch(`http://127.0.0.1:${port}/dashboard`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  assert.match(html, /<label for="activityFilter">Agent activity<\/label>/)
  for (const choice of ['All checkpoints', 'Working', 'Finished']) assert.ok(html.includes(choice))
  assert.ok(html.includes('checkpoints shown'))
  assert.ok(html.includes('Agent checkpoints (unexpired)'))
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const agents = ['starting', 'editing', 'testing', 'pushing', 'done', 'aborted', 'failed', 'custom', undefined]
    .map((status, i) => ({ agentId: `worker-${i}`, repo: 'forge', status }))
  agents.push({ agentId: 'brain-worker', repo: 'brain', status: 'editing' })
  let next = {
    generatedAt: '2026-11-05T07:00:00Z', liveAgentsCount: agents.length, recentEventsCount: 1,
    liveAgents: agents, liveByRepo: { forge: 9, brain: 1 },
    recentEvents: [{ eventType: 'pr_opened', repo: 'forge', prNumber: 55 }],
  }
  let failed = false
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() }, Date, AbortController,
    fetch: async () => { if (failed) throw new Error('offline'); return { ok: true, json: async () => next } },
    setTimeout: () => 1, clearTimeout: () => {},
  })
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  const select = (id: string, value: string) => { el(id).value = value; el(id).onchange() }
  assert.equal(el('liveCount').textContent, '10')
  const events = el('events').innerHTML
  select('activityFilter', 'working')
  assert.equal(el('liveCount').textContent, '7')
  for (const i of [4, 5, 6]) assert.ok(!el('agents').innerHTML.includes(`worker-${i}`))
  for (const i of [7, 8]) assert.ok(el('agents').innerHTML.includes(`worker-${i}`))
  assert.equal(el('events').innerHTML, events)
  select('repoFilter', 'forge')
  assert.equal(el('liveCount2').textContent, '6')
  assert.match(el('byRepo').innerHTML, /<b>6<\/b>forge/)
  failed = true
  await vm.runInContext('refresh()', context)
  assert.equal(el('activityFilter').value, 'working')
  assert.equal(el('repoFilter').value, 'forge')
  select('activityFilter', 'finished')
  assert.equal(el('liveCount').textContent, '3')
  assert.equal(el('events').innerHTML, events)
  select('repoFilter', 'brain')
  assert.equal(el('liveCount').textContent, '0')
  assert.match(el('agents').innerHTML, /no matching agent checkpoints/)
  failed = false
  next = { ...next, liveAgents: [{ agentId: 'brain-finished', repo: 'brain', status: 'done' }] }
  await vm.runInContext('refresh()', context)
  assert.equal(el('activityFilter').value, 'finished')
  assert.equal(el('repoFilter').value, 'brain')
  assert.match(el('agents').innerHTML, /brain-finished/)
  assert.equal(el('liveCount').textContent, '1')
  select('activityFilter', 'all')
  assert.equal(el('liveCount').textContent, '1')
})
