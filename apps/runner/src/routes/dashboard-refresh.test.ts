import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

class Element {
  private text = ''
  innerHTML = ''
  className = ''
  set textContent(value: unknown) {
    this.text = String(value)
    this.innerHTML = this.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  get textContent() { return this.text }
}

const snapshot = () => ({
  generatedAt: '2026-11-05T07:00:00Z', liveAgentsCount: 1, recentEventsCount: 1,
  liveAgents: [{ agentId: '<agent>', status: 'editing', intent: '<script>bad</script>' }],
  liveByRepo: { '<repo>': 1 },
  recentEvents: [{ eventType: 'pr_opened', repo: 'owner/forge', prNumber: 22 }],
  liveTasks: [{ id: '123456789', status: 'running', promptSnippet: '<task>' }],
  liveTasksCount: 1, liveTasksByRepo: { forge: 1 },
})

async function servedScript() {
  const app = express().use(dashboardRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const previous = process.env.GITHUB_ORG
  process.env.GITHUB_ORG = 'custom-org</script>'
  try {
    const address = server.address() as { port: number }
    const html = await (await fetch(`http://127.0.0.1:${address.port}/dashboard`)).text()
    assert.ok(html.includes('role="status"'))
    assert.ok(!html.includes('custom-org</script>'))
    return html.match(/<script>([\s\S]*?)<\/script>/)![1]
  } finally {
    if (previous === undefined) delete process.env.GITHUB_ORG
    else process.env.GITHUB_ORG = previous
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

async function harness(script: string) {
  const elements = new Map<string, Element>()
  const requests: { signal: AbortSignal; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = []
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
    fetch: (_url: string, options: { signal: AbortSignal }) => new Promise((resolve, reject) => {
      requests.push({ signal: options.signal, resolve, reject })
    }),
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
  const success = async (value = snapshot()) => {
    requests.at(-1)!.resolve({ ok: true, json: async () => value }); await settle()
  }
  return { elements, requests, timers, context, settle, runTimer, success }
}

test('served dashboard preserves its board across failures, bounds polls and recovers', async () => {
  const script = await servedScript()
  const h = await harness(script)
  assert.equal(h.requests.length, 1)
  vm.runInContext('refresh()', h.context)
  assert.equal(h.requests.length, 1, 'only one poll in flight')
  await h.success()
  const el = (id: string) => h.elements.get(id)!
  assert.match(el('connection').textContent, /^Connected · last success:/)
  assert.equal(el('connectionDot').className, 'dot')
  assert.match(el('agents').innerHTML, /&lt;script&gt;/)
  assert.match(el('events').innerHTML, /github.com\/custom-org&lt;\/script&gt;\/forge\/pull\/22/)
  const boardIds = ['agents', 'events', 'byRepo', 'generatedAt', 'liveCount', 'eventCount', 'liveCount2', 'eventCount2']
  const board = () => boardIds.map(id => el(id).innerHTML)
  // Also run this suite with PR #22 applied to verify renderer compatibility.
  if (script.includes('function renderTasks(')) {
    assert.match(el('tasks').innerHTML, /&lt;task&gt;/)
    assert.equal(el('taskCount2').textContent, '1')
    boardIds.push('tasks', 'tasksByRepo', 'taskCount2')
  }
  const good = board()
  for (const failure of ['500', 'malformed', 'nested', 'rejection', 'json', 'timeout']) {
    await h.runTimer(5000)
    const request = h.requests.at(-1)!
    if (failure === '500') request.resolve({ ok: false, status: 500, json: () => { throw new Error('must not parse') } })
    if (failure === 'malformed') request.resolve({ ok: true, json: async () => ({}) })
    if (failure === 'nested') request.resolve({ ok: true, json: async () => ({ ...snapshot(), liveAgents: [{ status: {} }] }) })
    if (failure === 'rejection') request.reject(new Error('offline'))
    if (failure === 'json') request.resolve({ ok: true, json: async () => { throw new Error('bad JSON') } })
    if (failure === 'timeout') {
      // Also bound a hung response body, even if fetch ignores abort.
      request.resolve({ ok: true, json: () => new Promise(() => {}) })
      await h.runTimer(10000)
      assert.equal(request.signal.aborted, true)
    }
    await h.settle()
    assert.deepEqual(board(), good)
    assert.match(el('connection').textContent, /^Stale · .* · last success:/)
    assert.ok(!el('connection').textContent.endsWith('never'))
    assert.equal(el('connectionDot').className, 'dot stale')
    assert.equal(h.timers.size, 1, 'only next poll remains')
  }
  await h.runTimer(5000)
  await h.success()
  assert.equal(el('connectionDot').className, 'dot')
  assert.match(el('connection').textContent, /^Connected/)
})

test('initial timeout shows never refreshed; late response cannot replace recovery', async () => {
  const h = await harness(await servedScript())
  const old = h.requests[0]
  await h.runTimer(10000)
  assert.match(h.elements.get('connection')!.textContent, /Stale.*last success: never/)
  await h.runTimer(5000)
  await h.success()
  old.resolve({ ok: true, json: async () => ({ ...snapshot(), liveAgentsCount: 999 }) })
  await h.settle()
  assert.equal(h.elements.get('liveCount')!.textContent, '1')
  assert.equal(h.elements.get('connectionDot')!.className, 'dot')
})
