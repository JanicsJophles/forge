import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

// Minimal DOM double (mirrors dashboard-own-tasks.test.ts). Every element
// exposes querySelectorAll() returning [] so disclosure-state paths don't throw.
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

// Freeze the clock so the elapsed label is deterministic. createdAt sits 723s
// (12m 03s) before "now" for the primary task.
const NOW = Date.parse('2026-11-05T12:00:00Z')
class FixedDate extends Date {
  constructor(...args: ConstructorParameters<typeof Date>) {
    if (args.length) super(...args)
    else super(NOW)
  }
  static now() { return NOW }
}

const snapshot = () => ({
  generatedAt: '2026-11-05T12:00:00Z', liveAgentsCount: 0, recentEventsCount: 0,
  liveAgents: [], liveByRepo: {}, recentEvents: [],
  liveTasks: [
    {
      id: 'task-1', repo: 'owner/forge', branch: 'fleet/forge/x',
      status: 'running', provider: 'claude', promptSnippet: 'do a thing',
      createdAt: '2026-11-05T11:47:57Z',
    },
  ],
  liveTasksCount: 1, liveTasksByRepo: { 'owner/forge': 1 },
})

async function servedScript() {
  const app = express().use(dashboardRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const address = server.address() as { port: number }
    const html = await (await fetch(`http://127.0.0.1:${address.port}/dashboard`)).text()
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
    AbortController, Date: FixedDate,
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
  const success = async (value = snapshot()) => {
    requests.at(-1)!.resolve({ ok: true, json: async () => value }); await settle()
  }
  return { el, settle, runTimer, success }
}

test('a live running task row shows a compact elapsed timer derived from createdAt', async () => {
  const h = await harness(await servedScript())
  await h.success()
  const tasks = () => h.el('tasks').innerHTML

  assert.match(tasks(), /class="task-row"/)
  assert.match(tasks(), /<span class="elapsed">12m 03s<\/span>/)
  assert.match(tasks(), /class="age">created \d+m ago/)
})

test('a queued task also shows an elapsed timer; a non-running status does not', async () => {
  const h = await harness(await servedScript())
  await h.success({
    ...snapshot(),
    liveTasks: [
      {
        id: 'task-q', repo: 'owner/forge', branch: 'fleet/forge/q',
        status: 'queued', provider: 'claude', promptSnippet: 'queued work',
        createdAt: '2026-11-05T10:55:57Z', // 1h 04m 03s before now
      },
      {
        id: 'task-done', repo: 'owner/forge', branch: 'fleet/forge/d',
        status: 'done', provider: 'claude', promptSnippet: 'finished',
        createdAt: '2026-11-05T11:47:57Z',
      },
    ],
  })
  const tasks = () => h.el('tasks').innerHTML

  assert.match(tasks(), /<span class="id">task-q<\/span>[\s\S]*?<span class="elapsed">1h 04m 03s<\/span>/)
  // The non-running row renders but carries no elapsed label.
  assert.match(tasks(), /<span class="id">task-done<\/span>/)
  const doneRow = tasks().split('<div class="task-row">').find(chunk => chunk.includes('task-done'))!
  assert.ok(!doneRow.includes('class="elapsed"'))
})

test('missing or malformed createdAt degrades gracefully — no NaN, no crash, no label', async () => {
  const h = await harness(await servedScript())
  await h.success({
    ...snapshot(),
    liveTasks: [
      {
        id: 'task-nocreated', repo: 'owner/forge', branch: 'fleet/forge/n',
        status: 'running', provider: 'claude', promptSnippet: 'no timestamp',
        createdAt: null,
      },
      {
        id: 'task-bad', repo: 'owner/forge', branch: 'fleet/forge/b',
        status: 'running', provider: 'claude', promptSnippet: 'bad timestamp',
        createdAt: 'not-a-date',
      },
    ],
  })
  const tasks = () => h.el('tasks').innerHTML

  assert.match(tasks(), /<span class="id">task-nocreated<\/span>/)
  assert.match(tasks(), /<span class="id">task-bad<\/span>/)
  assert.ok(!tasks().includes('class="elapsed"'))
  assert.ok(!tasks().includes('NaN'))
  assert.match(h.el('connection').textContent, /^Connected/)
})
