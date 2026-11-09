import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

// Minimal DOM double. Every element exposes querySelectorAll() returning [] so
// the dashboard's disclosure-state code paths never throw (see #63 gotcha).
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
  liveTasks: [
    {
      id: 'task-1', repo: 'owner/forge', branch: 'fleet/forge/x',
      status: 'running', provider: 'claude', promptSnippet: 'do a thing',
      createdAt: '2026-11-05T06:59:00Z',
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
    assert.match(html, /Runner tasks \(own\)/)
    assert.match(html, /id="tasks"/)
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
  const select = (id: string, value: string) => { el(id).value = value; el(id).onchange() }
  const success = async (value = snapshot()) => {
    requests.at(-1)!.resolve({ ok: true, json: async () => value }); await settle()
  }
  return { elements, el, select, settle, runTimer, success }
}

test('runner own tasks render with escaped fields and track the repo + activity filters', async () => {
  const h = await harness(await servedScript())
  await h.success()
  const tasks = () => h.el('tasks').innerHTML

  assert.match(tasks(), /class="task-row"/)
  assert.match(tasks(), /<span class="id">task-1<\/span>/)
  assert.match(tasks(), /<span class="repo">owner\/forge<\/span>/)
  assert.match(tasks(), /branch: fleet\/forge\/x/)
  assert.match(tasks(), /<span class="status status-running">running<\/span>/)
  assert.match(tasks(), /<span class="provider">claude<\/span>/)
  assert.match(tasks(), /<a class="log" target="_blank" rel="noopener" href="\/tasks\/task-1\/log\/view">log<\/a>/)
  assert.match(tasks(), /<a class="changes" target="_blank" rel="noopener" href="\/tasks\/task-1\/changes\/view">changes<\/a>/)
  assert.match(tasks(), /<button type="button" class="cancel" data-task-id="task-1" onclick="cancelTask\(this\)">cancel<\/button>/)
  assert.match(tasks(), /<div class="intent">do a thing<\/div>/)
  assert.match(tasks(), /class="age">created \d+[smhd] ago/)
  assert.equal(h.el('taskCount2').textContent, '1')
  assert.match(h.el('tasksByRepo').innerHTML, /<span class="pill"><b>1<\/b>owner\/forge<\/span>/)

  // Hostile fields must be escaped — no raw tags survive into the DOM.
  await h.runTimer(5000)
  await h.success({
    ...snapshot(),
    liveTasks: [{
      id: '"><img src=x onerror=alert(1)>', repo: 'owner/forge',
      branch: '</div><script>bad</script>&', status: 'queued',
      provider: 'claude', promptSnippet: 'x', createdAt: '2026-11-05T06:50:00Z',
    }],
  })
  assert.ok(!tasks().includes('<img'))
  assert.ok(!tasks().includes('<script>bad'))
  assert.match(tasks(), /&lt;img src=x/)
  assert.match(tasks(), /&lt;\/div&gt;&lt;script&gt;bad/)
  assert.match(tasks(), /<span class="status status-queued">queued<\/span>/)

  // Filtering to another repo hides the task; filtering to finished hides it too.
  await h.runTimer(5000)
  await h.success()
  h.select('repoFilter', 'owner/brain')
  assert.match(tasks(), /no matching runner tasks/)
  assert.equal(h.el('taskCount2').textContent, '0')
  h.select('repoFilter', '')
  assert.match(tasks(), /task-1/)
  h.select('activityFilter', 'finished')
  assert.match(tasks(), /no active runner tasks/)
  assert.equal(h.el('taskCount2').textContent, '0')

  // A snapshot with no liveTasks field at all must not throw.
  h.select('activityFilter', 'all')
  await h.runTimer(5000)
  const { liveTasks, liveTasksCount, liveTasksByRepo, ...noTasks } = snapshot()
  await h.success(noTasks)
  assert.match(tasks(), /no active runner tasks/)
  assert.match(h.el('connection').textContent, /^Connected/)
})

test('runner tasks render without a provider and encode the id in the log link', async () => {
  const h = await harness(await servedScript())
  const tasks = () => h.el('tasks').innerHTML
  await h.success({
    ...snapshot(),
    liveTasks: [{
      id: 'task a/b', repo: 'owner/forge', branch: 'fleet/forge/x',
      status: 'running', provider: '', promptSnippet: 'do a thing',
      createdAt: '2026-11-05T06:59:00Z',
    }],
  })
  // No provider → no badge, but the row (and its log link) still render.
  assert.match(tasks(), /class="task-row"/)
  assert.ok(!tasks().includes('class="provider"'))
  assert.match(tasks(), /href="\/tasks\/task%20a%2Fb\/log\/view"/)
  // The changes anchor and the cancel button encode the id the same way.
  assert.match(tasks(), /<a class="changes" target="_blank" rel="noopener" href="\/tasks\/task%20a%2Fb\/changes\/view">changes<\/a>/)
  assert.match(tasks(), /data-task-id="task%20a%2Fb"/)
})

test('runner tasks omit cancel and changes controls when the id is missing', async () => {
  const h = await harness(await servedScript())
  const tasks = () => h.el('tasks').innerHTML
  await h.success({
    ...snapshot(),
    liveTasks: [{
      id: '', repo: 'owner/forge', branch: 'fleet/forge/x',
      status: 'running', provider: 'claude', promptSnippet: 'do a thing',
      createdAt: '2026-11-05T06:59:00Z',
    }],
  })
  // A row with no id still renders, but gets no cancel button or changes link.
  assert.match(tasks(), /class="task-row"/)
  assert.ok(!tasks().includes('class="cancel"'))
  assert.ok(!tasks().includes('class="changes"'))
})
