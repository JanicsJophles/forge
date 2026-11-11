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
  return { elements, requests, el, take, resolveWith, submit, settle }
}


async function ready() {
  const h = await harness(await servedScript())
  await h.resolveWith('/repos', { ok: true, json: async () => [{ path: '/opt/repos/fleet-forge', currentBranch: 'fleet/next' }] })
  h.el('launchRepo').value = '/opt/repos/fleet-forge'
  h.el('launchPrompt').value = 'keep prompt'
  h.el('launchModel').value = 'model'
  h.el('launchAutoCommit').checked = true
  h.el('authToken').value = 'private-token'
  h.el('launchSubmit').textContent = 'Launch task'
  await h.submit()
  assert.equal(h.el('launchSubmit').disabled, true)
  return h
}

function retryable(h: Awaited<ReturnType<typeof ready>>) {
  assert.equal(h.el('launchPrompt').value, 'keep prompt')
  assert.equal(h.el('launchRepo').value, '/opt/repos/fleet-forge')
  assert.equal(h.el('launchModel').value, 'model')
  assert.equal(h.el('launchAutoCommit').checked, true)
  assert.equal(h.el('launchSubmit').disabled, false)
  assert.equal(h.el('launchSubmit').textContent, 'Launch task')
  assert.equal(h.el('launchSuccess').innerHTML, '')
  assert.ok(!h.el('launchErr').textContent.includes('private-token'))
}

test('201 validates the task id and immediately links to its encoded log', async () => {
  const h = await ready()
  h.take('/tasks').resolve({ ok: true, status: 201, json: async () => ({ taskId: 'a/b? <x>"' }) })
  await h.settle()
  assert.match(h.el('launchSuccess').innerHTML, /href="\/tasks\/a%2Fb%3F%20%3Cx%3E%22\/log\/view"/)
  assert.equal(h.el('launchPrompt').value, '')
  assert.equal(h.el('launchSubmit').disabled, false)
  assert.equal(h.el('launchSubmit').textContent, 'Launch task')
  assert.equal(h.el('launchErr').textContent, '')
  await h.submit()
  assert.equal(h.el('launchSuccess').innerHTML, '')
})

for (const [status, error] of [
  [401, 'unauthorized'],
  [409, 'requested branch does not match the repository checkout'],
  [429, 'capacity exhausted'],
  [507, 'insufficient disk space'],
] as const) {
  test('HTTP ' + status + ' includes the server reason safely and retains inputs', async () => {
    const h = await ready()
    h.take('/tasks').resolve({ ok: false, status, json: async () => ({ error: error + ' <img> private-token', reason: 'checkout-conflict' }) })
    await h.settle()
    retryable(h)
    assert.ok(h.el('launchErr').textContent.includes('HTTP ' + status))
    assert.ok(h.el('launchErr').textContent.includes(error))
    assert.match(h.el('launchErr').textContent, /checkout-conflict/)
    assert.ok(!h.el('launchErr').innerHTML.includes('<img>'))
  })
}

test('malformed and missing error bodies use a bounded actionable fallback', async () => {
  for (const json of [async () => { throw new Error('invalid JSON private-token') }, async () => ({}), async () => ({ error: 'x'.repeat(5000) })]) {
    const h = await ready()
    h.take('/tasks').resolve({ ok: false, status: 502, json })
    await h.settle()
    retryable(h)
    assert.match(h.el('launchErr').textContent, /HTTP 502/)
    assert.ok(h.el('launchErr').textContent.length < 550)
    assert.ok(h.el('launchErr').textContent.includes('runner logs') || h.el('launchErr').textContent.includes('xxx'))
  }
})

test('invalid success bodies retain the prompt and warn against duplicate launches', async () => {
  for (const body of [null, {}, { taskId: '' }, { taskId: 42 }, { taskId: 'private-token' }]) {
    const h = await ready()
    h.take('/tasks').resolve({ ok: true, status: 201, json: async () => body })
    await h.settle()
    retryable(h)
    assert.match(h.el('launchErr').textContent, /task may have started/)
  }
  const h = await ready()
  h.take('/tasks').resolve({ ok: true, status: 201, json: async () => { throw new Error('bad json') } })
  await h.settle()
  retryable(h)
})

test('network failures redact the token and always restore the launch button', async () => {
  const h = await ready()
  h.take('/tasks').reject(new Error('offline private-token'))
  await h.settle()
  retryable(h)
  assert.match(h.el('launchErr').textContent, /offline \[redacted\]/)
})
