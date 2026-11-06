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

async function harness() {
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
  assert.match(html, /Recent event snapshot/)
  assert.match(html, /id="eventCoverage" role="status" aria-live="polite"/)
  assert.doesNotMatch(html, /events \(24h\)|no events in last 24h/)
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  let next: unknown
  let failed = false
  let requests = 0
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() },
    Date, AbortController,
    fetch: async (url: string) => {
      assert.equal(url, '/agent-context')
      requests++
      if (failed) throw new Error('offline')
      return { ok: true, json: async () => next }
    },
    setTimeout: () => 1, clearTimeout: () => {},
  })
  // Suppress the initial poll so each test explicitly supplies its first snapshot.
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1].replace(/    refresh\(\);\s*$/, '')
  vm.runInContext(script, context)
  return {
    el, context,
    requests: () => requests,
    load: async (value: unknown) => { next = value; failed = false; await vm.runInContext('refresh()', context) },
    fail: async () => { failed = true; await vm.runInContext('refresh()', context) },
    select: (id: string, value: string) => { el(id).value = value; el(id).onchange() },
  }
}

const snapshot = (metadata: Record<string, unknown> = {}, count = 200) => ({
  generatedAt: '2026-11-05T07:00:00Z', liveAgentsCount: 0, liveAgents: [], liveByRepo: {},
  recentEventsCount: count,
  recentEvents: Array.from({ length: count }, (_, id) => ({
    id, eventType: 'pr_opened', repo: 'forge', ticket: 'FORGE-1', details: { title: 'loaded event' },
  })),
  ...metadata,
})

test('coverage distinguishes truncated, untruncated and unknown replacement snapshots', async () => {
  const h = await harness()
  await h.load(snapshot({ recentEventsTruncated: true, oldestRecentEventId: 123 }))
  assert.match(h.el('eventCoverage').textContent, /older events are omitted/)
  assert.match(h.el('eventCoverage').textContent, /Filters search only the loaded snapshot/)
  await h.load(snapshot({ recentEventsTruncated: false }))
  assert.match(h.el('eventCoverage').textContent, /no truncation for the returned window/)
  assert.doesNotMatch(h.el('eventCoverage').textContent, /older events are omitted/)
  await h.load(snapshot())
  assert.match(h.el('eventCoverage').textContent, /coverage unknown/)
  assert.doesNotMatch(h.el('eventCoverage').textContent, /no truncation|older events are omitted|cursor/)
  await h.load(snapshot({}, 0))
  assert.match(h.el('events').innerHTML, /no events in recent snapshot/)
  assert.match(h.el('eventCoverage').textContent, /coverage unknown/)
})

test('filters and failed refresh retain full-snapshot coverage and cached disclosures', async () => {
  const h = await harness()
  await h.load(snapshot({ recentEventsTruncated: true }))
  vm.runInContext('openEventDetails.add("0")', h.context)
  h.select('repoFilter', 'absent-repo')
  assert.match(h.el('events').innerHTML, /no matching events in recent snapshot/)
  assert.equal(h.el('eventCount2').textContent, '0')
  const notice = h.el('eventCoverage').textContent
  assert.match(notice, /older events are omitted/)
  const board = h.el('events').innerHTML
  await h.fail()
  assert.equal(h.el('eventCoverage').textContent, notice)
  assert.equal(h.el('events').innerHTML, board)
  assert.match(h.el('connection').textContent, /^Stale/)
  h.select('repoFilter', 'forge')
  assert.match(h.el('events').innerHTML, /data-event-id="0"[^>]* open/)
  assert.equal(h.el('eventCoverage').textContent, notice)
  // Exercise pending ticket/type filters too when running the composed dashboard.
  for (const [id, variable] of [['ticketFilter', 'selectedTicket'], ['eventTypeFilter', 'selectedEventType']]) {
    if (vm.runInContext(`typeof ${variable} !== 'undefined'`, h.context)) {
      h.select(id, 'absent-value')
      assert.match(h.el('events').innerHTML, /recent snapshot/)
      assert.equal(h.el('eventCoverage').textContent, notice)
      h.select(id, '')
    }
  }
  assert.equal(h.requests(), 2, 'filter changes never fetch')
  await h.load(snapshot({ recentEventsTruncated: false }, 0))
  assert.match(h.el('eventCoverage').textContent, /no truncation for the returned window/)
})
