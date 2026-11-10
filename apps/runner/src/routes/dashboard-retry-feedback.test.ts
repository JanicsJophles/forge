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



async function ready() {
  const h = await harness(await servedScript())
  h.el('authToken').value = 'private-token'
  const inserted: Element[] = []
  const button = {
    dataset: { taskId: 'old%2Ftask' }, disabled: false, textContent: 'retry',
    closest: () => null,
    insertAdjacentElement: (_where: string, el: Element) => inserted.push(el),
  }
  h.context.__button = button
  vm.runInContext('retryTask(__button)', h.context)
  await h.settle()
  const post = h.take('/tasks/old%2Ftask/retry')
  assert.equal(post.options?.method, 'POST')
  assert.equal(post.options?.headers?.Authorization, 'Bearer private-token')
  const finish = async (status: number, body: unknown, broken = false) => {
    post.resolve({ ok: status < 300, status, json: async () => {
      if (broken) throw new Error('bad JSON private-token')
      return body
    } })
    await h.settle()
    assert.equal(button.disabled, false)
    assert.equal(button.textContent, 'retry')
    assert.equal(inserted.length, 1)
    assert.equal(h.requests.filter(r => r.options?.method === 'POST').length, 0)
    assert.ok(!inserted[0].innerHTML.includes('private-token'))
    return inserted[0]
  }
  return { finish }
}

test('retry success links directly to a safely encoded new run', async () => {
  const h = await ready()
  const msg = await h.finish(201, { taskId: 'a/b? <img>"' })
  assert.match(msg.className, /ok/)
  assert.ok(msg.innerHTML.includes('/tasks/a%2Fb%3F%20%3Cimg%3E%22/log/view'))
  assert.match(msg.innerHTML, /Open retried task/)
  assert.ok(!msg.innerHTML.includes('<img>'))
})

test('malformed retry success warns of possible dispatch and links history', async () => {
  for (const body of [null, {}, { taskId: '' }, { taskId: ' ' }, { taskId: 42 },
    { taskId: 'x'.repeat(201) }, { taskId: 'private-token' }]) {
    const msg = await (await ready()).finish(201, body)
    assert.match(msg.textContent, /task may have started/)
    assert.match(msg.innerHTML, /href="\/history"/)
    assert.doesNotMatch(msg.innerHTML, /Open retried task/)
  }
  const msg = await (await ready()).finish(201, null, true)
  assert.match(msg.textContent, /task may have started/)
  assert.match((await (await ready()).finish(200, { taskId: 'fresh' })).textContent, /task may have started/)
})

for (const [status, error] of [
  [409, 'checkout conflict'], [429, 'capacity exhausted'], [507, 'insufficient disk space'],
] as const) {
  test('retry surfaces HTTP ' + status + ' details with redaction and HTML safety', async () => {
    const msg = await (await ready()).finish(status, {
      error: error + ' <img> private-token', reason: 'reason private-token <script>',
    })
    assert.ok(msg.textContent.includes('HTTP ' + status))
    assert.ok(msg.textContent.includes(error))
    assert.match(msg.textContent, /reason \[redacted\]/)
    assert.ok(!msg.innerHTML.includes('<img>'))
    assert.ok(!msg.innerHTML.includes('<script>'))
  })
}

test('retry error fallback and long hostile feedback remain bounded', async () => {
  for (const body of [null, {}, { error: 42 }, { error: 'private-token' + 'x'.repeat(5000) }]) {
    const msg = await (await ready()).finish(502, body)
    assert.match(msg.textContent, /HTTP 502/)
    assert.ok(msg.textContent.length < 550)
  }
  assert.match((await (await ready()).finish(502, null, true)).textContent, /check runner logs/)
})
