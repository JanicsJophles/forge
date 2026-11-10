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

test('selected checkout state is inert, local, and explicit about failed or unknown probes', async () => {
  const h = await harness(await servedScript())
  await h.resolveWith('/repos', { ok: true, json: async () => [
    { path: '/clean', currentBranch: 'fleet/next', dirty: false },
    { path: '/dirty<img>', name: '<script>evil</script>', currentBranch: '<img onerror=evil>', dirty: true },
    { path: '/failed', dirty: false, branchError: 'unavailable', statusError: 'unavailable' },
    { path: '/unknown' },
  ] })
  const choose = (path: string) => {
    h.el('launchRepo').value = path
    h.el('launchRepo').onchange()
    return h.el('launchRepoState').textContent
  }
  assert.match(choose('/clean'), /\/clean · branch: fleet\/next · clean checkout/)
  assert.match(choose('/dirty<img>'), /Warning: dirty checkout/)
  assert.ok(!h.el('launchRepoState').innerHTML.includes('<img'))
  assert.ok(!h.el('launchRepo').innerHTML.includes('<script>'))
  assert.match(choose('/failed'), /branch probe failed · status unknown \(status probe failed\)/)
  assert.ok(!h.el('launchRepoState').textContent.includes('clean'))
  assert.match(choose('/unknown'), /branch unknown · status unknown/)
  assert.equal(h.requests.filter(r => r.url === '/repos').length, 0)
  choose('/dirty<img>')
  h.el('launchPrompt').value = 'launch despite warning'
  await h.submit()
  const post = h.take('/tasks')
  assert.equal(JSON.parse(post.options!.body!).repo, '/dirty<img>')
  post.resolve({ ok: true, status: 201, json: async () => ({ taskId: 'dirty-run' }) })
  await h.settle()
  h.el('launchPrompt').value = 'preserved draft'
  vm.runInContext('loadRepos()', h.context)
  await h.resolveWith('/repos', { ok: false, status: 503 })
  assert.match(h.el('launchRepoState').textContent, /Stale repository state \(reload failed\)/)
  assert.equal(h.el('launchRepo').value, '/dirty<img>')
  assert.equal(h.el('launchPrompt').value, 'preserved draft')
  vm.runInContext('loadRepos()', h.context)
  await h.resolveWith('/repos', { ok: true, json: async () => [
    { path: '/dirty<img>', currentBranch: 'updated', dirty: false },
  ] })
  assert.match(h.el('launchRepoState').textContent, /branch: updated · clean checkout/)
  assert.ok(!h.el('launchRepoState').textContent.includes('Stale'))
})
