import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

// Minimal DOM double matching the other dashboard suites.
class Element {
  innerHTML = ''
  value = ''
  className = ''
  onchange = () => {}
  querySelectorAll() { return [] }
  private text = ''
  set textContent(value: unknown) {
    this.text = String(value)
    this.innerHTML = this.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  get textContent() { return this.text }
}

const snapshot = () => ({
  generatedAt: '2026-11-05T07:00:00Z', liveAgentsCount: 0, recentEventsCount: 0,
  liveAgents: [], liveByRepo: {}, recentEvents: [],
  liveTasks: [], liveTasksCount: 0, liveTasksByRepo: {},
  capacity: { activeTasks: 2, maxConcurrentTasks: 5, availableSlots: 3 },
})

async function servedScript() {
  const app = express().use(dashboardRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const address = server.address() as { port: number }
    const html = await (await fetch(`http://127.0.0.1:${address.port}/dashboard`)).text()
    assert.match(html, /id="capacity"/)
    return html.match(/<script>([\s\S]*?)<\/script>/)![1]
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

async function harness(script: string) {
  const elements = new Map<string, Element>()
  const requests: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let timerId = 0
  const context = vm.createContext({
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, new Element())
        return elements.get(id)!
      },
      createElement: () => new Element(),
    },
    AbortController, Date,
    fetch: () => new Promise((resolve, reject) => { requests.push({ resolve, reject }) }),
    setTimeout: (fn: () => void, ms: number) => { timers.set(++timerId, { fn, ms }); return timerId },
    clearTimeout: (id: number) => timers.delete(id),
  })
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  vm.runInContext(script, context)
  const runTimer = async (ms: number) => {
    const entry = [...timers].find(([, t]) => t.ms === ms)
    assert.ok(entry, `missing ${ms}ms timer`)
    timers.delete(entry[0]); entry[1].fn(); await settle()
  }
  const el = (id: string) => elements.get(id) ?? (() => { throw new Error(`no element ${id}`) })()
  const success = async (value: unknown = snapshot()) => {
    requests.at(-1)!.resolve({ ok: true, json: async () => value }); await settle()
  }
  return { el, settle, runTimer, success }
}

test('header renders the capacity stat from snapshot.capacity', async () => {
  const h = await harness(await servedScript())
  await h.success()
  assert.equal(h.el('capacity').textContent, 'slots: 2/5 (3 free)')
  // The rest of the board still renders alongside the stat.
  assert.match(h.el('connection').textContent, /^Connected/)
})

test('absent capacity (older runner) degrades the stat to a dash', async () => {
  const h = await harness(await servedScript())
  const { capacity, ...noCapacity } = snapshot()
  await h.success(noCapacity)
  assert.equal(h.el('capacity').textContent, '—')
  assert.match(h.el('connection').textContent, /^Connected/)
})

test('malformed capacity values are hidden without blanking the board', async () => {
  const h = await harness(await servedScript())
  const cases: unknown[] = [
    { activeTasks: -1, maxConcurrentTasks: 5, availableSlots: 3 }, // negative
    { activeTasks: 2, maxConcurrentTasks: 5 },                      // missing availableSlots
    { activeTasks: 1.5, maxConcurrentTasks: 5, availableSlots: 3 }, // non-integer
    { activeTasks: '2', maxConcurrentTasks: '5', availableSlots: '3' }, // strings
    [2, 5, 3],                                                      // array, not a record
    null,                                                           // null
    'nope',                                                         // primitive
  ]
  for (const [i, bad] of cases.entries()) {
    // The initial refresh() already has a request in flight; only subsequent
    // polls need the 5s timer fired first.
    if (i > 0) await h.runTimer(5000)
    await h.success({ ...snapshot(), capacity: bad })
    assert.equal(h.el('capacity').textContent, '—', `capacity ${JSON.stringify(bad)} must dash`)
    // A malformed capacity must not blank the rest of the snapshot.
    assert.match(h.el('connection').textContent, /^Connected/)
  }

  // Recovers to a real stat on the next good poll.
  await h.runTimer(5000)
  await h.success()
  assert.equal(h.el('capacity').textContent, 'slots: 2/5 (3 free)')
})

test('a full runner shows zero free slots', async () => {
  const h = await harness(await servedScript())
  await h.success({ ...snapshot(), capacity: { activeTasks: 5, maxConcurrentTasks: 5, availableSlots: 0 } })
  assert.equal(h.el('capacity').textContent, 'slots: 5/5 (0 free)')
})
