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
  return { elements, requests, el, take, resolveWith, submit, settle, context, timers }
}

const repos = (paths: string[]) => ({ ok: true, json: async () => paths.map(path => ({ path, name: path })) })

test('initial discovery failure can recover without changing launch draft or feedback', async () => {
  const h = await harness(await servedScript())
  const draft = ['launchPrompt', 'launchProvider', 'launchModel', 'authToken']
  draft.forEach(id => { h.el(id).value = id + ' draft' })
  h.el('launchAutoCommit').checked = true
  h.el('launchErr').textContent = 'existing feedback'
  h.el('launchSuccess').textContent = 'existing success'
  assert.equal(h.el('reloadRepos').disabled, true)
  await h.resolveWith('/repos', { ok: false, status: 503 })
  assert.match(h.el('reposStatus').textContent, /Could not load/)
  h.el('reloadRepos').onclick()
  h.el('reloadRepos').onclick()
  assert.equal(h.requests.filter(r => r.url === '/repos').length, 1)
  assert.match(h.el('reposStatus').textContent, /Loading/)
  await h.resolveWith('/repos', repos(['/repo']))
  assert.equal(h.el('launchRepo').disabled, false)
  assert.equal(h.el('reloadRepos').disabled, false)
  draft.forEach(id => assert.equal(h.el(id).value, id + ' draft'))
  assert.equal(h.el('launchAutoCommit').checked, true)
  assert.equal(h.el('launchErr').textContent, 'existing feedback')
  assert.equal(h.el('launchSuccess').textContent, 'existing success')
  assert.ok(h.requests.every(r => r.options?.method !== 'POST'))
})

test('reload preserves a surviving selection and requires a new choice after removal or empty discovery', async () => {
  const h = await harness(await servedScript())
  await h.resolveWith('/repos', repos(['/a', '/b']))
  h.el('launchRepo').value = '/b'
  h.el('reloadRepos').onclick()
  await h.resolveWith('/repos', repos(['/b', '/a']))
  assert.equal(h.el('launchRepo').value, '/b')
  h.el('reloadRepos').onclick()
  await h.resolveWith('/repos', repos(['/a']))
  assert.equal(h.el('launchRepo').value, '')
  assert.match(h.el('reposStatus').textContent, /no longer available/)
  h.el('launchPrompt').value = 'keep me'
  await h.submit()
  assert.match(h.el('launchErr').textContent, /select a repository/)
  assert.ok(!h.requests.some(r => r.options?.method === 'POST'))
  h.el('reloadRepos').onclick()
  await h.resolveWith('/repos', repos([]))
  assert.equal(h.el('launchRepo').disabled, true)
  assert.match(h.el('reposStatus').textContent, /No repositories available/)
  assert.equal(h.el('reloadRepos').disabled, false)
})

test('repository names and paths cannot inject markup', async () => {
  const h = await harness(await servedScript())
  await h.resolveWith('/repos', { ok: true, json: async () => [
    { path: '/repo" onclick="evil', name: '<img src=x onerror=evil>' },
    { path: '/fallback<name>' }, { name: 'skip' },
  ] })
  assert.ok(!h.el('launchRepo').innerHTML.includes('<img'))
  assert.match(h.el('launchRepo').innerHTML, /&lt;img/)
  assert.match(h.el('launchRepo').innerHTML, /&quot; onclick=&quot;evil/)
  assert.match(h.el('launchRepo').innerHTML, /fallback&lt;name&gt;/)
  assert.ok(!h.el('launchRepo').innerHTML.includes('>skip<'))
})

for (const phase of ['headers', 'body']) {
  test('deadline fences late ' + phase + ' responses after a successful retry', async () => {
    const h = await harness(await servedScript())
    const old = h.take('/repos')
    let finishBody: (value: unknown) => void = () => {}
    if (phase === 'body') {
      old.resolve({ ok: true, json: () => new Promise(resolve => { finishBody = resolve }) })
      await h.settle()
    }
    const deadline = [...h.timers].find(([, timer]) => timer.ms === 10000)!
    h.timers.delete(deadline[0])
    deadline[1].fn()
    await h.settle()
    assert.match(h.el('reposStatus').textContent, /Could not load/)
    h.el('reloadRepos').onclick()
    await h.resolveWith('/repos', repos(['/new']))
    const recovered = h.el('launchRepo').innerHTML
    if (phase === 'headers') old.resolve(repos(['/old']))
    else finishBody([{ path: '/old' }])
    await h.settle()
    assert.equal(h.el('launchRepo').innerHTML, recovered)
    assert.equal(h.el('reposStatus').textContent, 'Repositories loaded.')
  })
}
