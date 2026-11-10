import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

class Element {
  innerHTML = ''
  value = 'private-token'
  disabled = false
  isConnected = true
  dataset = { taskId: 'task%2Fone' }
  messages: Element[] = []
  buttons: Element[] = []
  private text = ''
  set textContent(value: string) {
    this.text = value
    this.innerHTML = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  get textContent() { return this.text }
  querySelectorAll() { return this.buttons }
  querySelector() { return { remove: () => { this.messages = [] } } }
  closest() { return this }
  insertAdjacentElement(_where: string, element: Element) { this.messages.push(element) }
}

async function harness() {
  const server = express().use(dashboardRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let script: string
  try {
    const { port } = server.address() as { port: number }
    const html = await (await fetch(`http://127.0.0.1:${port}/dashboard`)).text()
    script = html.match(/<script>([\s\S]*?)<\/script>/)![1]
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const requests: { url: string; options: { method?: string; signal: AbortSignal; headers: Record<string, string> }; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let id = 0
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() },
    confirm: () => true, AbortController, Date,
    fetch: (url: string, options: typeof requests[number]['options']) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    setTimeout: (fn: () => void, ms: number) => { timers.set(++id, { fn, ms }); return id },
    clearTimeout: (key: number) => timers.delete(key),
  })
  vm.runInContext(script, context)
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
  const cancel = (button = new Element()) => {
    context.button = button
    vm.runInContext('cancelTask(button)', context)
    return button
  }
  const deadline = async (ms = 15000) => {
    const entry = [...timers].find(([, t]) => t.ms === ms)
    assert.ok(entry)
    timers.delete(entry[0]); entry[1].fn(); await settle()
  }
  const render = () => vm.runInContext("renderTasks([{id:'task/one',status:'running'}])", context)
  const deletes = () => requests.filter(r => r.options?.method === 'DELETE')
  return { context, el, requests, timers, settle, cancel, deadline, render, deletes }
}

for (const phase of ['headers', 'body']) {
  test(`cancel bounds hung ${phase}, preserves rerenders, and ignores late settlement`, async () => {
    const h = await harness()
    const original = h.cancel()
    const old = h.deletes()[0]
    assert.equal(old.url, '/tasks/task%2Fone')
    assert.equal(old.options.headers.Authorization, 'Bearer private-token')
    h.cancel()
    assert.equal(h.deletes().length, 1)
    h.render()
    assert.match(h.el('tasks').innerHTML, /disabled>cancelling…/)
    let finishBody: (v: unknown) => void = () => {}
    if (phase === 'body') {
      old.resolve({ ok: false, status: 409, json: () => new Promise(resolve => { finishBody = resolve }) })
      await h.settle()
    }
    original.isConnected = false
    const replacement = new Element()
    h.el('tasks').buttons = [replacement]
    await h.deadline()
    assert.equal(old.options.signal.aborted, true)
    assert.equal(replacement.disabled, false)
    assert.match(replacement.messages[0].textContent, /outcome unknown.*Check task status/)
    assert.equal(h.deletes().length, 1, 'never automatically repeat DELETE')
    h.render()
    assert.match(h.el('tasks').innerHTML, /outcome unknown/)
    h.cancel(replacement)
    if (phase === 'headers') old.resolve({ ok: true })
    else finishBody({ error: 'late rejection' })
    await h.settle()
    assert.equal(replacement.disabled, true)
    assert.equal(replacement.textContent, 'cancelling…')
    h.deletes()[1].resolve({ ok: true })
    await h.settle()
    assert.equal(replacement.textContent, 'cancel requested')
    h.render()
    assert.match(h.el('tasks').innerHTML, /disabled>cancel requested/)
    assert.ok(!h.el('tasks').innerHTML.includes('outcome unknown'))
    assert.ok(![...h.timers.values()].some(t => t.ms === 15000))
    // Cancellation did not consume the independent poll deadline.
    await h.deadline(10000)
    assert.match(h.el('connection').textContent, /Stale/)
    assert.ok([...h.timers.values()].some(t => t.ms === 5000))
  })
}

test('HTTP rejection details are bounded, redacted and rendered as text', async () => {
  const h = await harness()
  const button = h.cancel()
  h.deletes()[0].resolve({ ok: false, status: 409, json: async () => ({ error: '<img>private-token', reason: 'private-token' + 'x'.repeat(2000) }) })
  await h.settle()
  assert.equal(button.disabled, false)
  const message = button.messages[0]
  assert.match(message.textContent, /cancel rejected: HTTP 409: <img>\[redacted\]: \[redacted\]/)
  assert.ok(message.textContent.length < 550)
  assert.ok(!message.innerHTML.includes('<img>'))
  h.render()
  assert.ok(!h.el('tasks').innerHTML.includes('private-token'))
})

test('network rejection is uncertain; invalid JSON rejection uses a fixed fallback', async () => {
  const h = await harness()
  const button = h.cancel()
  h.deletes()[0].reject(new Error('private-token transport detail'))
  await h.settle()
  assert.match(button.messages[0].textContent, /outcome unknown/)
  assert.ok(!button.messages[0].textContent.includes('private-token'))
  h.cancel(button)
  h.deletes()[1].resolve({ ok: false, status: 502, json: async () => { throw new Error('<html>private-token') } })
  await h.settle()
  assert.match(button.messages[0].textContent, /HTTP 502: server returned no usable JSON error; check runner logs/)
})
