import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

class Element {
  innerHTML = ''
  value = ''
  onchange = () => {}
  querySelectorAll() { return [] }
  private text = ''
  set textContent(value: unknown) {
    this.text = String(value)
    this.innerHTML = this.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  get textContent() { return this.text }
}

test('Recent tasks disclose failures independently, retain rows and recover', async () => {
  const server = express().use(dashboardRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    const { port } = server.address() as { port: number }
    html = await (await fetch(`http://127.0.0.1:${port}/dashboard`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const requests: { url: string; signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let timerId = 0
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() },
    AbortController, Date,
    fetch: (url: string, options: { signal: AbortSignal }) => new Promise((resolve, reject) => requests.push({ url, signal: options.signal, resolve, reject })),
    setTimeout: (fn: () => void, ms: number) => { timers.set(++timerId, { fn, ms }); return timerId },
    clearTimeout: (id: number) => timers.delete(id),
  })
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
  const start = () => { vm.runInContext('refreshRecentTasks()', context); return requests.at(-1)! }
  const respond = async (request: typeof requests[number], rows: unknown) => {
    request.resolve({ ok: true, json: async () => rows }); await settle()
  }
  const runTimer = async (ms: number) => {
    const entry = [...timers].reverse().find(([, t]) => t.ms === ms)
    assert.ok(entry, `missing ${ms}ms timer`)
    timers.delete(entry[0]); entry[1].fn(); await settle()
  }
  const row = (id: string) => ({ id, status: 'failed', repo: 'chosen' })
  const first = start()
  first.reject(new Error('offline')); await settle()
  assert.match(el('recentHealth').textContent, /Recent tasks unavailable.*offline.*last update: never/)
  // The independent board succeeds without clearing history health.
  await respond(requests[0], {
    generatedAt: new Date().toISOString(), liveAgentsCount: 0, recentEventsCount: 0,
    liveAgents: [], recentEvents: [], liveByRepo: {},
  })
  assert.match(el('connection').textContent, /^Connected/)
  assert.match(el('recentHealth').textContent, /unavailable/)
  await respond(start(), [row('retained')])
  assert.match(el('recentHealth').textContent, /^Recent tasks current/)
  assert.doesNotMatch(el('recentHealth').textContent, /never/)
  const rows = el('recentTasks').innerHTML
  const updated = el('recentHealth').textContent.split('last update: ')[1]
  for (const value of [{}, [null], [{ status: {} }]]) {
    await respond(start(), value)
    assert.match(el('recentHealth').textContent, /Recent tasks stale.*invalid task history/)
    assert.ok(el('recentHealth').textContent.endsWith(updated))
    assert.equal(el('recentTasks').innerHTML, rows)
  }
  const badHttp = start()
  badHttp.resolve({ ok: false, status: 503 }); await settle()
  assert.match(el('recentHealth').textContent, /stale.*HTTP 503/)
  assert.equal(el('recentTasks').innerHTML, rows)
  const hung = start()
  let finishBody!: (rows: unknown) => void
  hung.resolve({ ok: true, json: () => new Promise(resolve => { finishBody = resolve }) })
  await settle(); await runTimer(10000)
  assert.equal(hung.signal.aborted, true)
  assert.match(el('recentHealth').textContent, /stale.*timed out/)
  assert.equal(el('recentTasks').innerHTML, rows)
  vm.runInContext("connection(false, 'board offline')", context)
  await runTimer(5000)
  await respond(requests.at(-1)!, [row('recovered')])
  assert.match(el('recentHealth').textContent, /^Recent tasks current/)
  assert.match(el('connection').textContent, /Stale.*board offline/)
  finishBody([row('too-late')]); await settle()
  assert.match(el('recentTasks').innerHTML, /recovered/)
  assert.doesNotMatch(el('recentTasks').innerHTML, /too-late/)
  // An older failure cannot overwrite a newer success, even in the same repo.
  const old = start()
  await respond(start(), [row('newest')])
  old.reject(new Error('old failure')); await settle()
  assert.match(el('recentHealth').textContent, /^Recent tasks current/)
  assert.match(el('recentTasks').innerHTML, /newest/)
  // Changing repository resets the timestamp and fences old failures.
  const previousRepo = start()
  vm.runInContext('window = {}', context)
  el('repoFilter').value = 'chosen'; el('repoFilter').onchange()
  assert.match(el('recentHealth').textContent, /loading.*last update: never/)
  await respond(requests.at(-1)!, [row('selected')])
  previousRepo.reject(new Error('wrong repo')); await settle()
  assert.match(el('recentHealth').textContent, /^Recent tasks current/)
  assert.match(el('recentTasks').innerHTML, /selected/)
})
