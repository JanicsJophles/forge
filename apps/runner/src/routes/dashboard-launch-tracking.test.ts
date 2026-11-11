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


test('tracking and HEAD follow the exact checkout, remain inert and preserve drafts on stale discovery', async () => {
  const h = await harness(await servedScript())
  const fixtures = [
    { path: '/a/forge', ahead: 0, behind: 3, head: { sha: 'abc1234', subject: '<img src=x onerror=evil>' } },
    { path: '/b/forge', ahead: 2, behind: 0, head: { sha: 'def5678', subject: 'ahead revision' } },
    { path: '/diverged', ahead: 2, behind: 4 },
    { path: '/zero', ahead: 0, behind: 0 },
    { path: '/absent' },
    { path: '/null', ahead: null, behind: null, head: null },
  ]
  await h.resolveWith('/repos', { ok: true, json: async () => fixtures.map(repo => ({ name: 'forge', currentBranch: 'fleet/next', ...repo })) })
  const choose = (path: string) => {
    h.el('launchRepo').value = path
    h.el('launchRepo').onchange()
    return h.el('launchRepoState').textContent
  }
  h.el('launchPrompt').value = 'draft'
  assert.match(choose('/a/forge'), /local tracking \(no fetch; freshness unknown\): ahead 0, behind 3 · HEAD: abc1234 — <img/)
  assert.ok(!h.el('launchRepoState').innerHTML.includes('<img'))
  assert.match(choose('/b/forge'), /ahead 2, behind 0 · HEAD: def5678 — ahead revision/)
  assert.ok(!h.el('launchRepoState').textContent.includes('abc1234'))
  assert.match(choose('/diverged'), /ahead 2, behind 4/)
  assert.match(choose('/zero'), /ahead 0, behind 0/)
  for (const path of ['/absent', '/null']) {
    assert.match(choose(path), /ahead unknown, behind unknown · HEAD: revision unknown/)
  }
  assert.equal(choose('/missing'), 'Repository state unknown.')
  choose('/a/forge')
  vm.runInContext('loadRepos()', h.context)
  await h.resolveWith('/repos', { ok: false, status: 503 })
  assert.match(h.el('launchRepoState').textContent, /Stale repository state.*ahead 0, behind 3.*abc1234/)
  assert.equal(h.el('launchPrompt').value, 'draft')
  assert.equal(h.el('launchRepo').value, '/a/forge')
  assert.equal(h.requests.filter(r => r.url === '/repos' || r.options?.method === 'POST').length, 0)
})

test('malformed tracking never coerces into counts and HEAD fields validate independently', async () => {
  const h = await harness(await servedScript())
  await h.resolveWith('/repos', { ok: true, json: async () => [] })
  for (const value of [-1, 0.5, '2', true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    vm.runInContext('loadRepos()', h.context)
    await h.resolveWith('/repos', { ok: true, json: async () => [
      { path: '/repo', ahead: value, behind: value, head: { sha: '<bad>', subject: 42 } },
    ] })
    h.el('launchRepo').value = '/repo'
    h.el('launchRepo').onchange()
    assert.match(h.el('launchRepoState').textContent, /ahead unknown, behind unknown · HEAD: revision unknown$/)
  }
  vm.runInContext('loadRepos()', h.context)
  await h.resolveWith('/repos', { ok: true, json: async () => [
    { path: '/repo', ahead: 1, behind: null, head: { subject: 'subject only' } },
  ] })
  assert.match(h.el('launchRepoState').textContent, /ahead 1, behind unknown · HEAD: revision unknown — subject only/)
})
