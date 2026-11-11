import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

// Minimal DOM double mirroring the other dashboard harnesses: textContent is
// HTML-escaped into innerHTML so the launcher's escape()/textContent safety is
// observable, and form inputs expose value/checked/onsubmit.
class Element {
  innerHTML = ''
  value = ''
  checked: boolean | undefined
  disabled = false
  className = ''
  onclick: () => void = () => {}
  onchange: () => void = () => {}
  onsubmit: (e: unknown) => void = () => {}
  querySelectorAll() {
    return []
  }
  private text = ''
  set textContent(value: unknown) {
    this.text = String(value)
    this.innerHTML = this.text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }
  get textContent() {
    return this.text
  }
}

async function servedScript() {
  const app = express().use(dashboardRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  try {
    const address = server.address() as { port: number }
    const html = await (await fetch(`http://127.0.0.1:${address.port}/dashboard`)).text()
    // The launcher markup is served statically.
    assert.match(html, /id="newTaskForm"/)
    assert.match(html, /id="launchRepo"/)
    assert.match(html, /id="launchPrompt"/)
    assert.match(html, /id="launchProvider"/)
    assert.match(html, /id="launchModel"/)
    assert.match(html, /id="launchAutoCommit"/)
    return html.match(/<script>([\s\S]*?)<\/script>/)![1]
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

interface PendingRequest {
  url: string
  options: { method?: string; body?: string; headers?: Record<string, string> } | undefined
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

async function harness(script: string) {
  const elements = new Map<string, Element>()
  const requests: PendingRequest[] = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let timerId = 0
  const context = vm.createContext({
    // A defined window makes the served script auto-wire the launcher on load.
    window: {},
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, new Element())
        return elements.get(id)!
      },
      createElement: () => new Element(),
    },
    AbortController,
    Date,
    JSON,
    fetch: (url: string, options?: PendingRequest['options']) =>
      new Promise((resolve, reject) => {
        requests.push({ url, options, resolve, reject })
      }),
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(++timerId, { fn, ms })
      return timerId
    },
    clearTimeout: (id: number) => timers.delete(id),
  })
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  vm.runInContext(script, context)
  await settle()
  // Auto-create like document.getElementById so a test can seed an input's value
  // before the script first reads it (the form reads inputs only inside submit).
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const take = (match: string) => {
    const index = requests.findIndex((r) => r.url.includes(match))
    assert.ok(index !== -1, `no pending request for ${match}`)
    return requests.splice(index, 1)[0]
  }
  const resolveWith = async (match: string, value: unknown) => {
    take(match).resolve(value)
    await settle()
  }
  const submit = async () => {
    el('newTaskForm').onsubmit({ preventDefault() {} })
    await settle()
  }
  return { elements, requests, el, take, resolveWith, submit, settle, context }
}

test('claims the displayed full-path snapshot and recovers from conflict only by explicit refresh and submit', async () => {
  const h = await harness(await servedScript())
  const repos = [
    { name: 'forge', path: '/a/forge', currentBranch: 'fleet/first' },
    { name: 'forge', path: '/b/forge', currentBranch: 'fleet/second' },
  ]
  await h.resolveWith('/repos', { ok: true, json: async () => repos })
  h.el('launchRepo').value = '/b/forge'
  h.el('launchRepo').onchange()
  h.el('launchPrompt').value = 'keep draft'
  h.el('launchProvider').value = 'codex'
  h.el('launchModel').value = 'model'
  h.el('launchAutoCommit').checked = true
  h.el('authToken').value = 'private-token'
  await h.submit()
  const post = h.take('/tasks')
  assert.deepEqual(JSON.parse(post.options!.body!), {
    repo: '/b/forge', branch: 'fleet/second', prompt: 'keep draft', provider: 'codex', model: 'model', autoCommit: true,
  })
  assert.equal(post.options?.headers?.Authorization, 'Bearer private-token')
  post.resolve({ ok: false, status: 409, json: async () => ({ error: 'requested branch does not match the repository checkout', reason: 'refresh checkout state' }) })
  await h.settle()
  assert.match(h.el('launchErr').textContent, /HTTP 409: requested branch.*refresh checkout state/)
  assert.match(h.el('launchRepoState').textContent, /branch: fleet\/second/)
  assert.equal(h.requests.filter(r => r.url === '/repos' || r.options?.method === 'POST').length, 0)
  assert.equal(h.el('launchPrompt').value, 'keep draft')
  assert.equal(h.el('launchProvider').value, 'codex')
  assert.equal(h.el('launchModel').value, 'model')
  assert.equal(h.el('launchAutoCommit').checked, true)
  h.el('reloadRepos').onclick()
  await h.resolveWith('/repos', { ok: true, json: async () => [{ ...repos[1], currentBranch: 'HEAD' }] })
  assert.match(h.el('launchRepoState').textContent, /branch: HEAD/)
  assert.equal(h.requests.filter(r => r.options?.method === 'POST').length, 0)
  await h.submit()
  const retry = h.take('/tasks')
  assert.equal(JSON.parse(retry.options!.body!).branch, 'HEAD')
  retry.resolve({ ok: true, status: 201, json: async () => ({ taskId: 'recovered' }) })
  await h.settle()
  assert.equal(h.el('launchPrompt').value, '')
  assert.match(h.el('launchSuccess').innerHTML, /recovered/)
})

test('unknown, failed, stale and pending discovery never launch with an inferred branch', async () => {
  const h = await harness(await servedScript())
  h.el('launchRepo').value = '/a/forge'
  h.el('launchPrompt').value = 'keep draft'
  await h.submit() // Initial discovery is still pending.
  assert.match(h.el('launchErr').textContent, /Refresh repositories/)
  await h.resolveWith('/repos', { ok: false, status: 503 })
  for (const metadata of [{}, { currentBranch: '' }, { currentBranch: null }, { currentBranch: 'old', branchError: 'failed' }]) {
    h.el('reloadRepos').onclick()
    await h.resolveWith('/repos', { ok: true, json: async () => [{ path: '/a/forge', ...metadata }] })
    await h.submit()
    assert.match(h.el('launchErr').textContent, /Refresh repositories/)
  }
  h.el('reloadRepos').onclick()
  await h.resolveWith('/repos', { ok: true, json: async () => [{ path: '/a/forge', currentBranch: 'known' }] })
  h.el('reloadRepos').onclick()
  await h.resolveWith('/repos', { ok: false, status: 503 })
  await h.submit()
  assert.match(h.el('launchRepoState').textContent, /Stale.*branch: known/)
  assert.match(h.el('launchErr').textContent, /Refresh repositories/)
  assert.equal(h.el('launchPrompt').value, 'keep draft')
  assert.equal(h.requests.filter(r => r.options?.method === 'POST').length, 0)
})
