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
  options: { method?: string; body?: string; signal?: AbortSignal; headers?: Record<string, string> } | undefined
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
  const deadline = async () => {
    const entry = [...timers].find(([, timer]) => timer.ms === 15000)
    assert.ok(entry)
    timers.delete(entry[0])
    entry[1].fn()
    await settle()
  }
  return { elements, requests, el, take, resolveWith, submit, settle, deadline, timers }
}


async function ready() {
  const h = await harness(await servedScript())
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

for (const phase of ['fetch', 'body']) {
  for (const late of ['success', 'failure']) {
    for (const timing of ['pending', 'completed']) {
    test(`hung ${phase} restores launcher and ignores late ${late} with newer launch ${timing}`, async () => {
      const h = await ready()
      const old = h.take('/tasks')
      // The transport deliberately ignores AbortSignal.
      let finish: (value: unknown) => void = old.resolve
      let fail = old.reject
      if (phase === 'body') {
        old.resolve({ ok: true, status: 201, json: () => new Promise((resolve, reject) => {
          finish = resolve
          fail = reject
        }) })
        await h.settle()
      }
      await h.deadline()
      retryable(h)
      assert.equal(old.options?.signal?.aborted, true)
      assert.match(h.el('launchErr').textContent, /outcome unknown.*Inspect task history before launching again/)
      assert.match(h.el('launchErr').innerHTML, /href="#recentTasks"/)
      assert.equal(h.requests.filter(r => r.options?.method === 'POST').length, 0)
      h.el('launchPrompt').value = 'new draft'
      await h.submit()
      const next = h.take('/tasks')
      if (timing === 'completed') {
        next.resolve({ ok: true, status: 201, json: async () => ({ taskId: 'new' }) })
        await h.settle()
        h.el('launchPrompt').value = 'new draft'
      }
      if (late === 'failure') fail(new Error('late private-token'))
      else finish(phase === 'body' ? { taskId: 'old' } : { ok: true, status: 201, json: async () => ({ taskId: 'old' }) })
      await h.settle()
      assert.equal(h.el('launchPrompt').value, 'new draft')
      assert.equal(h.el('launchSubmit').disabled, timing === 'pending')
      assert.equal(h.el('launchErr').innerHTML, '')
      if (timing === 'completed') {
        assert.match(h.el('launchSuccess').innerHTML, /tasks\/new\/log\/view/)
        return
      }
      assert.equal(h.el('launchSuccess').innerHTML, '')
      next.resolve({ ok: true, status: 201, json: async () => ({ taskId: 'new' }) })
      await h.settle()
      assert.equal(h.el('launchPrompt').value, '')
      assert.equal(h.el('launchSubmit').disabled, false)
      assert.match(h.el('launchSuccess').innerHTML, /tasks\/new\/log\/view/)
      assert.ok(![...h.timers.values()].some(t => t.ms === 15000))
    })
    }
  }
}

test('network and malformed successes link history and redact diagnostic tokens', async () => {
  for (const failure of ['network', 'json', 'id']) {
    const h = await ready()
    const request = h.take('/tasks')
    if (failure === 'network') request.reject(new Error('<img>private-token'))
    else request.resolve({ ok: true, status: 201, json: async () => {
      if (failure === 'json') throw new Error('private-token')
      return { taskId: 'private-token' }
    } })
    await h.settle()
    retryable(h)
    assert.match(h.el('launchErr').innerHTML, /href="#recentTasks"/)
    assert.ok(!h.el('launchErr').innerHTML.includes('private-token'))
    assert.ok(!h.el('launchErr').innerHTML.includes('<img>'))
  }
})
