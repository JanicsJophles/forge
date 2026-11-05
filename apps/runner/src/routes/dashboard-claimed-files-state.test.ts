import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
class Element {
  private html = ''
  private text = ''
  disclosures: { dataset: { agentId: string }; open: boolean }[] = []
  value = ''
  className = ''
  onchange = () => {}
  set innerHTML(value: string) {
    this.html = value
    this.disclosures = [...value.matchAll(/<details class="claimed-files" data-agent-id="([^"]*)"( open)?>/g)]
      .map(m => ({ dataset: { agentId: decode(m[1]) }, open: !!m[2] }))
  }
  get innerHTML() { return this.html }
  set textContent(value: unknown) {
    this.text = String(value)
    this.innerHTML = this.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  get textContent() { return this.text }
  querySelectorAll(selector: string) {
    assert.equal(selector, 'details.claimed-files')
    return this.disclosures
  }
}

test('claimed disclosures survive polls and filters, and reset only after full-snapshot removal', async () => {
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
  assert.match(html, /overflow-wrap: anywhere;/)
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const hostile = '__proto__"><script>bad</script>&'
  const path = '</li><img src=x onerror="bad">&' + 'long/'.repeat(100)
  const agents = [
    { agentId: hostile, repo: 'forge', status: 'done', filesTouched: [path] },
    { agentId: 'constructor', repo: 'brain', status: 'editing', filesTouched: ['other.ts'] },
  ]
  let next: unknown
  const snapshot = (liveAgents = agents) => ({
    generatedAt: '2026-11-05T07:00:00Z', liveAgents, liveAgentsCount: liveAgents.length,
    recentEventsCount: 0, recentEvents: [], liveByRepo: { forge: 1, brain: 1 },
  })
  next = snapshot()
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let timerId = 0
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() },
    Date, AbortController,
    fetch: async () => ({ ok: true, json: async () => next }),
    setTimeout: (fn: () => void, ms: number) => { timers.set(++timerId, { fn, ms }); return timerId },
    clearTimeout: (id: number) => timers.delete(id),
  })
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  await settle()
  const poll = async () => {
    const timer = [...timers].find(([, t]) => t.ms === 5000)!
    assert.ok(timer)
    timers.delete(timer[0]); timer[1].fn(); await settle()
  }
  const select = (repo: string) => { el('repoFilter').value = repo; el('repoFilter').onchange() }
  const disclosure = (id: string) => el('agents').disclosures.find(d => d.dataset.agentId === id)!
  assert.equal(disclosure(hostile).open, false)
  disclosure(hostile).open = true
  await poll()
  assert.equal(disclosure(hostile).open, true)
  assert.equal(disclosure('constructor').open, false)
  assert.doesNotMatch(el('agents').innerHTML, /<script>|<img/)
  assert.ok(el('agents').innerHTML.includes('&lt;/li&gt;&lt;img src=x onerror=&quot;bad&quot;&gt;&amp;' + 'long/'.repeat(100)))
  // Also exercise #60 when this test runs in a combined dashboard checkout.
  if (html.includes('id="activityFilter"')) {
    const activity = el('activityFilter')
    activity.value = 'active'; activity.onchange()
    assert.equal(disclosure(hostile), undefined)
    await poll()
    activity.value = 'all'; activity.onchange()
    assert.equal(disclosure(hostile).open, true)
  }
  select('brain')
  disclosure('constructor').open = true
  await poll() // Hidden agent remains in the full snapshot.
  select('forge')
  assert.equal(disclosure(hostile).open, true)
  disclosure(hostile).open = false
  select('')
  assert.equal(disclosure(hostile).open, false)
  assert.equal(disclosure('constructor').open, true)
  await poll()
  assert.equal(disclosure(hostile).open, false)

  // No disclosure temporarily, but the agent still exists.
  next = snapshot(agents.map(a => ({ ...a, filesTouched: [] })))
  await poll()
  next = snapshot()
  await poll()
  assert.equal(disclosure('constructor').open, true)
  select('forge')
  next = snapshot([agents[0]]) // Remove the hidden agent from the full snapshot.
  await poll()
  next = snapshot()
  await poll()
  select('')
  assert.equal(disclosure('constructor').open, false)

  disclosure(hostile).open = true
  next = { ...snapshot(), liveAgents: [42] } // Invalid polls must not prune state.
  await poll()
  assert.match(el('connection').textContent, /^Stale/)
  select('missing')
  select('')
  assert.equal(disclosure(hostile).open, true)
  next = snapshot([])
  await poll()
  next = snapshot()
  await poll()
  assert.equal(disclosure(hostile).open, false)
})
