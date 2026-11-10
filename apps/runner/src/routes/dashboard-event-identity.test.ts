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

test('full event identities stay escaped and distinct across polls and filters', async () => {
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
  assert.match(html, /\.event-row \{ overflow-wrap: anywhere; \}/)
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const prefix = 'fleet-forge-shared-prefix-'
  const first = prefix + 'one'
  const second = prefix + 'two'
  const hostile = prefix + 'x'.repeat(2000) + '</span><script>alert("x")</script>&'
  const events = [first, second, hostile, undefined, null, ''].map((agentId, index) => ({
    id: index + 1, agentId, repo: index === 1 ? 'brain' : 'forge', eventType: 'pr_opened',
    prNumber: 12, details: { title: 'safe <details>' },
  }))
  let next = { generatedAt: '2026-11-10T07:00:00Z', liveAgentsCount: 0, recentEventsCount: events.length, liveAgents: [], liveByRepo: {}, recentEvents: events }
  let requests = 0
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() },
    Date, AbortController,
    fetch: async () => { requests++; return { ok: true, json: async () => next } },
    setTimeout: () => 1, clearTimeout: () => {},
  })
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  const rendered = () => el('events').innerHTML
  const check = () => {
    assert.ok(rendered().includes('<span class="agent">by ' + first + '</span>'))
    assert.ok(rendered().includes('<span class="agent">by ' + second + '</span>'))
    assert.ok(rendered().includes('x'.repeat(2000) + '&lt;/span&gt;&lt;script&gt;'))
    assert.doesNotMatch(rendered(), /<script>|by undefined|by null/)
    assert.equal((rendered().match(/class="agent"/g) || []).length, 3)
    assert.match(rendered(), /href="https:\/\/github.com\/JanicsJophles\/forge\/pull\/12"/)
    assert.match(rendered(), /<summary>Event details<\/summary>/)
    assert.match(rendered(), /safe &lt;details&gt;/)
  }
  check()
  await vm.runInContext('refresh()', context)
  check()
  const before = requests
  el('repoFilter').value = 'brain'
  el('repoFilter').onchange()
  assert.ok(rendered().includes(second))
  assert.ok(!rendered().includes(first))
  el('repoFilter').value = ''
  el('repoFilter').onchange()
  check()
  assert.equal(requests, before, 'filter renders use the loaded snapshot')
  // Also exercise the exact identity filter when composed with PR215.
  if (html.includes('id="agentFilter"')) {
    el('agentFilter').value = first
    el('agentFilter').onchange()
    assert.ok(rendered().includes(first))
    assert.ok(!rendered().includes(second))
    await vm.runInContext('refresh()', context)
    assert.ok(rendered().includes(first))
    assert.ok(!rendered().includes(second))
    el('agentFilter').value = ''
    el('agentFilter').onchange()
    check()
  }
  next = { ...next, recentEvents: events.slice(3) }
  await vm.runInContext('refresh()', context)
  assert.doesNotMatch(rendered(), /class="agent"|by undefined|by null/)
})
