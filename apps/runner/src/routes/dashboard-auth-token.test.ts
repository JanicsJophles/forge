import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

// When the runner is started with FORGE_AUTH_TOKEN, state-changing routes answer
// 401 without an Authorization header. These tests drive the served dashboard
// script and assert the bearer token is attached to the three state-changing
// fetches (launch POST /tasks, cancel DELETE /tasks/:id, retry POST
// /tasks/:id/retry) and to no read fetch (/capabilities, /repos, /agent-context,
// /tasks history poll).

// Minimal DOM double. style defaults to display:none so the reveal is observable;
// buttons expose the surface cancelTask/retryTask touch (dataset/closest/…).
class Element {
  innerHTML = ''
  value = ''
  checked: boolean | undefined
  disabled = false
  className = ''
  style: { display: string } = { display: 'none' }
  onsubmit: (e: unknown) => void = () => {}
  oninput: () => void = () => {}
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
    // The token input markup is served statically and hidden by default.
    assert.match(html, /id="authTokenRow"[^>]*style="display: none;"/)
    assert.match(html, /<input type="password" id="authToken"/)
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
  const store = new Map<string, string>()
  let timerId = 0
  const context = vm.createContext({
    window: {},
    sessionStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
    confirm: () => true,
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
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const find = (match: string) => requests.find((r) => r.url.includes(match))
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
  // Invoke a global (cancelTask/retryTask) with a fake button. The function is a
  // top-level declaration in the same global scope, so it is in scope here.
  const invoke = async (name: string, button: unknown) => {
    ;(context as Record<string, unknown>).__btn = button
    vm.runInContext(`${name}(__btn)`, context)
    await settle()
  }
  const button = (taskId: string) => ({
    dataset: { taskId },
    disabled: false,
    textContent: 'x',
    closest: () => null,
    insertAdjacentElement: () => {},
  })
  const runTimer = async (ms: number) => {
    const entry = [...timers].find(([, t]) => t.ms === ms)
    assert.ok(entry, `missing ${ms}ms timer`)
    timers.delete(entry[0])
    entry[1].fn()
    await settle()
  }
  const authOf = (r: PendingRequest | undefined) => r?.options?.headers?.Authorization
  return { elements, requests, store, el, find, take, resolveWith, submit, invoke, button, runTimer, authOf, settle }
}

test('auth token: capabilities reveals the input, and state-changing fetches carry the bearer token', async () => {
  const h = await harness(await servedScript())

  // At load the dashboard probed /capabilities, /repos and /agent-context — all
  // reads, none carrying an Authorization header.
  for (const path of ['/capabilities', '/repos', '/agent-context']) {
    assert.equal(h.authOf(h.find(path)), undefined, `${path} must stay header-free`)
  }

  // authRequired:true reveals the hidden token row.
  assert.equal(h.el('authTokenRow').style.display, 'none')
  await h.resolveWith('/capabilities', { ok: true, json: async () => ({ authRequired: true }) })
  assert.equal(h.el('authTokenRow').style.display, '')

  // Typing a token persists it to sessionStorage.
  h.el('authToken').value = 's3cret-token'
  h.el('authToken').oninput()
  assert.equal(h.store.get('forge.authToken'), 's3cret-token')

  // Launch: POST /tasks carries the bearer token alongside the JSON content type.
  await h.resolveWith('/repos', { ok: true, json: async () => [{ name: 'forge', path: '/opt/repos/fleet-forge', currentBranch: 'fleet/next' }] })
  h.el('launchRepo').value = '/opt/repos/fleet-forge'
  h.el('launchPrompt').value = 'do a thing'
  h.el('launchProvider').value = 'claude'
  h.el('launchSubmit').textContent = 'Launch task'
  await h.submit()
  const post = h.take('/tasks')
  assert.equal(post.options!.method, 'POST')
  assert.equal(post.options!.headers!['Content-Type'], 'application/json')
  assert.equal(post.options!.headers!.Authorization, 'Bearer s3cret-token')
  post.resolve({ ok: true, status: 201, json: async () => ({ taskId: 'abc' }) })
  await h.settle()

  // Cancel: DELETE /tasks/:id carries the bearer token.
  await h.invoke('cancelTask', h.button('task-1'))
  const del = h.take('/tasks/task-1')
  assert.equal(del.options!.method, 'DELETE')
  assert.equal(del.options!.headers!.Authorization, 'Bearer s3cret-token')
  del.resolve({ ok: true, status: 200, json: async () => ({}) })
  await h.settle()

  // Retry: POST /tasks/:id/retry carries the bearer token.
  await h.invoke('retryTask', h.button('task-2'))
  const retry = h.take('/tasks/task-2/retry')
  assert.equal(retry.options!.method, 'POST')
  assert.equal(retry.options!.headers!.Authorization, 'Bearer s3cret-token')
  retry.resolve({ ok: true, status: 201, json: async () => ({ taskId: 'def' }) })
  await h.settle()

  // Read polls stay header-free even after a token is set: the deferred history
  // poll (GET /tasks?limit=15) carries no Authorization header.
  await h.runTimer(0)
  assert.equal(h.authOf(h.take('/tasks?limit=15')), undefined)
})

test('auth token: input stays hidden and no Authorization header is sent when auth is off', async () => {
  const h = await harness(await servedScript())

  // authRequired:false keeps the token row hidden.
  await h.resolveWith('/capabilities', { ok: true, json: async () => ({ authRequired: false }) })
  assert.equal(h.el('authTokenRow').style.display, 'none')

  // With no token typed, the three state-changing fetches omit Authorization.
  await h.resolveWith('/repos', { ok: true, json: async () => [{ name: 'forge', path: '/opt/repos/fleet-forge', currentBranch: 'fleet/next' }] })
  h.el('launchRepo').value = '/opt/repos/fleet-forge'
  h.el('launchPrompt').value = 'do a thing'
  await h.submit()
  const post = h.take('/tasks')
  assert.equal(post.options!.headers!['Content-Type'], 'application/json')
  assert.equal(post.options!.headers!.Authorization, undefined)
  post.resolve({ ok: true, status: 201, json: async () => ({ taskId: 'abc' }) })
  await h.settle()

  await h.invoke('cancelTask', h.button('task-1'))
  assert.equal(h.take('/tasks/task-1').options!.headers!.Authorization, undefined)

  await h.invoke('retryTask', h.button('task-2'))
  assert.equal(h.take('/tasks/task-2/retry').options!.headers!.Authorization, undefined)
})

test('auth token: an unreachable /capabilities leaves the input hidden without throwing', async () => {
  const h = await harness(await servedScript())
  h.take('/capabilities').reject(new Error('offline'))
  await h.settle()
  assert.equal(h.el('authTokenRow').style.display, 'none')
  // The launcher still works; it just can't attach a token.
  await h.resolveWith('/repos', { ok: true, json: async () => [{ name: 'forge', path: '/opt/repos/fleet-forge', currentBranch: 'fleet/next' }] })
  h.el('launchRepo').value = '/opt/repos/fleet-forge'
  h.el('launchPrompt').value = 'do a thing'
  await h.submit()
  assert.equal(h.take('/tasks').options!.headers!.Authorization, undefined)
})
