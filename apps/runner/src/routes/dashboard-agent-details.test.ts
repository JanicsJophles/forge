import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

class Element {
  querySelectorAll() { return [] }
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
    assert.match(html, /section \{\s*min-width: 0;/)
    assert.match(html, /overflow-wrap: anywhere;/)
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


test('agent branch and claimed files render as text and refresh from snapshots', async () => {
  const h = await harness(await servedScript())
  const branch = '<img src=x onerror="alert(1)"> & quoted'
  const path = '</li><script>alert("file")</script>&' + 'long/'.repeat(100)
  const agent = { agentId: 'worker', status: 'editing', branch, filesTouched: [path, 'src/"quoted".ts'] }
  await h.success({ ...snapshot(), liveAgents: [agent] })
  const html = () => h.elements.get('agents')!.innerHTML
  assert.match(html(), /branch: &lt;img/)
  assert.match(html(), /<details class="claimed-files" data-agent-id="worker"><summary>Claimed files \(2\)<\/summary><ul>/)
  assert.match(html(), /<li>&lt;\/li&gt;&lt;script&gt;/)
  assert.ok(html().includes('&amp;' + 'long/'.repeat(100)))
  assert.ok(html().includes('onerror=&quot;alert(1)&quot;&gt;'))
  assert.ok(html().includes('<li>src/&quot;quoted&quot;.ts</li>'))
  assert.ok(!html().includes('<img'))
  assert.ok(!html().includes('<script>'))
  assert.equal((html().match(/<li>/g) || []).length, 2)

  await h.runTimer(5000)
  await h.success({ ...snapshot(), liveAgents: [{ ...agent, branch: 'fleet/new', filesTouched: ['new.ts'] }] })
  assert.match(html(), /branch: fleet\/new/)
  assert.match(html(), /Claimed files \(1\)/)
  assert.ok(!html().includes('long/'))

  const good = html()
  for (const invalid of [{ branch: {} }, { filesTouched: 'bad' }, { filesTouched: [42] }]) {
    await h.runTimer(5000)
    await h.success({ ...snapshot(), liveAgents: [{ ...agent, ...invalid }] })
    assert.equal(html(), good, 'invalid details preserve the last good board')
    assert.match(h.elements.get('connection')!.textContent, /^Stale/)
  }

  await h.runTimer(5000)
  await h.success({ ...snapshot(), liveAgents: [
    { agentId: 'missing' },
    { agentId: 'empty', branch: '', filesTouched: [] },
    { agentId: 'null', branch: null, filesTouched: null },
  ] })
  assert.ok(!html().includes('class="branch"'))
  assert.ok(!html().includes('<details'))
  assert.equal((html().match(/class="agent-row"/g) || []).length, 3)
})
