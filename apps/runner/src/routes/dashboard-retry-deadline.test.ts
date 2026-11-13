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
  options: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal } | undefined
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

async function ready() {
  const h = await harness(await servedScript())
  h.el('authToken').value = 'private-token'
  const inserted: Element[] = []
  const makeButton = () => ({
    dataset: { taskId: 'old%2Ftask' }, disabled: false, textContent: 'retry',
    closest: () => null,
    insertAdjacentElement: (_where: string, el: Element) => inserted.push(el),
    insertAdjacentHTML: (_where: string, html: string) => { const el = new Element(); el.innerHTML = html; inserted.push(el) },
  })
  const button = makeButton()
  const retry = async (b = button) => {
    h.context.__button = b
    vm.runInContext('void retryTask(__button)', h.context)
    await h.settle()
  }
  await retry()
  const post = h.take('/tasks/old%2Ftask/retry')
  const deadline = [...h.timers.values()].filter(t => t.ms === 15000).at(-1)!
  const expire = async () => { deadline.fn(); await h.settle() }
  const restored = () => {
    assert.equal(button.disabled, false)
    assert.equal(button.textContent, 'retry')
    assert.equal(h.requests.filter(r => r.options?.method === 'POST').length, 0)
    assert.doesNotMatch(inserted.at(-1)!.innerHTML, /private-token/)
  }
  return { ...h, post, inserted, button, retry, expire, restored, makeButton }
}

for (const phase of ['fetch', 'json']) {
  test('retry deadline bounds hanging ' + phase + ' and fences late success', async () => {
    const h = await ready()
    let body!: (v: unknown) => void
    if (phase === 'json') {
      h.post.resolve({ ok: true, status: 201, json: () => new Promise(resolve => { body = resolve }) })
      await h.settle()
    }
    assert.equal(h.button.disabled, true)
    await h.expire()
    h.restored()
    assert.equal(h.post.options?.signal?.aborted, true)
    assert.match(h.inserted[0].textContent, /Retry outcome unknown/)
    assert.match(h.inserted[0].innerHTML, /href="\/history"/)
    await h.retry()
    const next = h.take('/retry')
    next.resolve({ ok: true, status: 201, json: async () => ({ taskId: 'newer' }) })
    await h.settle()
    const feedback = h.inserted.at(-1)!.innerHTML
    if (phase === 'json') body({ taskId: 'late' })
    else h.post.resolve({ ok: true, status: 201, json: async () => ({ taskId: 'late' }) })
    await h.settle()
    assert.equal(h.inserted.at(-1)!.innerHTML, feedback)
    assert.equal(h.inserted.length, 2)
    assert.match(feedback, /newer/)
  })
}

test('network loss is unknown, redacted, and never automatically redispatched', async () => {
  const h = await ready()
  h.post.reject(new Error('lost private-token <img>'))
  await h.settle()
  h.restored()
  assert.match(h.inserted[0].textContent, /Retry outcome unknown/)
  assert.match(h.inserted[0].innerHTML, /href="\/history"/)
  assert.doesNotMatch(h.inserted[0].innerHTML, /<img>/)
})

for (const status of [401, 409, 201]) {
  test('retry HTTP ' + status + ' preserves explicit results and captured credentials', async () => {
    const h = await ready()
    h.el('authToken').value = 'changed'
    h.post.resolve({ ok: status === 201, status, json: async () => status === 201
      ? { taskId: 'fresh/a' } : { error: 'rejected private-token', reason: 'detail' } })
    await h.settle()
    h.restored()
    assert.equal(h.post.options?.headers?.Authorization, 'Bearer private-token')
    assert.equal(h.post.options?.method, 'POST')
    if (status === 201) assert.match(h.inserted[0].innerHTML, /fresh%2Fa\/log\/view/)
    else {
      assert.match(h.inserted[0].textContent, new RegExp('HTTP ' + status + ': rejected \\[redacted\\]: detail'))
      assert.doesNotMatch(h.inserted[0].textContent, /outcome unknown/)
    }
  })
}

test('polling replacements retain the task lock and receive settled feedback', async () => {
  const h = await ready()
  vm.runInContext("renderRecentTasks([{id:'old/task',status:'failed'}])", h.context)
  assert.match(h.el('recentTasks').innerHTML, /disabled>retrying/)
  const replacement = h.makeButton()
  const feedback: string[] = []
  replacement.insertAdjacentHTML = (_where, html) => { feedback.push(html) }
  h.el('recentTasks').querySelectorAll = () => [replacement] as any
  await h.retry(replacement)
  assert.equal(h.requests.filter(r => r.options?.method === 'POST').length, 0)
  await h.expire()
  assert.equal(replacement.disabled, false)
  assert.equal(replacement.textContent, 'retry')
  assert.match(feedback[0], /Retry outcome unknown/)
  vm.runInContext("renderRecentTasks([{id:'old/task',status:'failed'}])", h.context)
  assert.doesNotMatch(h.el('recentTasks').innerHTML, /disabled>retrying/)
  assert.match(h.el('recentTasks').innerHTML, /Retry outcome unknown/)
})
