import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

// Minimal DOM double mirroring the other dashboard harnesses: textContent is
// HTML-escaped into innerHTML so the renderer's escape()/textContent safety is
// observable, and createElement()'d nodes track className/textContent.
class Element {
  innerHTML = ''
  value = ''
  className = ''
  disabled = false
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

// A stand-in for a rendered retry <button>. retryTask() only reads dataset,
// disabled, textContent, closest(), and inserts feedback via insertAdjacentElement.
class FakeButton {
  dataset: { taskId: string }
  disabled = false
  textContent = 'retry'
  inserted: Element[] = []
  constructor(id: string) {
    this.dataset = { taskId: encodeURIComponent(id) }
  }
  closest() {
    return null
  }
  insertAdjacentElement(_position: string, element: Element) {
    this.inserted.push(element)
  }
}

async function servedScript() {
  const app = express().use(dashboardRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  try {
    const address = server.address() as { port: number }
    const html = await (await fetch(`http://127.0.0.1:${address.port}/dashboard`)).text()
    // The Recent tasks panel markup is served statically.
    assert.match(html, /Recent tasks/)
    assert.match(html, /id="recentTasks"/)
    assert.match(html, /id="recentCount"/)
    return html.match(/<script>([\s\S]*?)<\/script>/)![1]
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

interface PendingRequest {
  url: string
  options: { method?: string; body?: string } | undefined
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

async function harness(script: string) {
  const elements = new Map<string, Element>()
  const requests: PendingRequest[] = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let timerId = 0
  const context = vm.createContext({
    // A defined window makes the served script wire the launcher + the deferred
    // recent-tasks poll on load (both exercised below via the timers/fetch doubles).
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
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const runTimer = async (ms: number) => {
    const entry = [...timers].find(([, t]) => t.ms === ms)
    assert.ok(entry, `missing ${ms}ms timer`)
    timers.delete(entry[0])
    entry[1].fn()
    await settle()
  }
  const take = (match: string) => {
    const index = requests.findIndex((r) => r.url.includes(match))
    assert.ok(index !== -1, `no pending request for ${match}`)
    return requests.splice(index, 1)[0]
  }
  // Fire the deferred first recent-tasks fetch and resolve it with `rows`.
  const firstRecent = async (rows: unknown) => {
    await runTimer(0)
    take('/tasks?limit=15').resolve({ ok: true, json: async () => rows })
    await settle()
  }
  const retry = async (button: FakeButton) => {
    ;(context as unknown as { __btn: FakeButton }).__btn = button
    vm.runInContext('retryTask(__btn)', context)
    await settle()
  }
  return { elements, requests, el, runTimer, take, settle, firstRecent, retry }
}

test('recent tasks: at load the deferred poll issues exactly one GET /tasks?limit=15', async () => {
  const h = await harness(await servedScript())
  // Nothing has fired the history fetch yet — it waits behind the 0ms timer so the
  // launcher harness never sees a /tasks GET racing its /tasks POST.
  assert.equal(h.requests.filter((r) => r.url.includes('/tasks?limit=15')).length, 0)
  await h.runTimer(0)
  assert.equal(h.requests.filter((r) => r.url.includes('/tasks?limit=15')).length, 1)
})

test('recent tasks render retry only on terminal rows, with commit/error lines', async () => {
  const h = await harness(await servedScript())
  await h.firstRecent([
    {
      id: 'done-1',
      repo: 'owner/forge',
      provider: 'claude',
      status: 'completed',
      commitSha: 'abcdef1234567',
      // A commit-less, error-bearing completed row must not leak either extra.
      errorMessage: 'ignored on completed',
      createdAt: '2026-11-05T06:50:00Z',
    },
    {
      id: 'fail-1',
      repo: 'owner/forge',
      provider: 'codex',
      status: 'failed',
      // commitSha on a failed row is not surfaced; the error message is.
      commitSha: 'deadbeef00000',
      errorMessage: 'exploded <mid-run>',
      createdAt: '2026-11-05T06:40:00Z',
    },
    { id: 'run-1', repo: 'owner/forge', provider: 'claude', status: 'running', createdAt: '2026-11-05T06:30:00Z' },
    { id: 'queue-1', repo: 'owner/forge', provider: 'claude', status: 'queued', createdAt: '2026-11-05T06:20:00Z' },
  ])
  const html = h.el('recentTasks').innerHTML

  // Core columns present for every row.
  assert.match(html, /<span class="id">done-1<\/span>/)
  assert.match(html, /<span class="repo">owner\/forge<\/span>/)
  assert.match(html, /<span class="provider">codex<\/span>/)
  assert.match(html, /<span class="status status-completed">completed<\/span>/)
  assert.match(html, /<span class="status status-failed">failed<\/span>/)
  assert.equal(h.el('recentCount').textContent, '4')

  // Terminal rows get a retry button (data-task-id is the only such marker).
  assert.match(html, /<button type="button" class="retry" data-task-id="done-1" onclick="retryTask\(this\)">retry<\/button>/)
  assert.match(html, /data-task-id="fail-1"[^>]*>retry<\/button>/)
  // Non-terminal rows render NO retry button.
  assert.ok(!html.includes('data-task-id="run-1"'))
  assert.ok(!html.includes('data-task-id="queue-1"'))

  // completed → short (7-char) commit; failed → escaped error message.
  assert.match(html, /<span class="commit">abcdef1<\/span>/)
  assert.ok(!html.includes('deadbee')) // failed row's commit is never shown
  assert.match(html, /<div class="error-message">exploded &lt;mid-run&gt;<\/div>/)
  // The completed row shows neither an error line nor the failed row's full sha.
  assert.ok(!html.includes('ignored on completed'))
  assert.ok(!html.includes('abcdef1234567')) // full sha is truncated, not raw
})

test('recent tasks: empty history renders a placeholder and a zero count', async () => {
  const h = await harness(await servedScript())
  await h.firstRecent([])
  assert.match(h.el('recentTasks').innerHTML, /no recent tasks/)
  assert.equal(h.el('recentCount').textContent, '0')
})

test('retryTask POSTs /tasks/:id/retry and surfaces 2xx then error feedback', async () => {
  const h = await harness(await servedScript())

  // 2xx path.
  const ok = new FakeButton('done-1')
  await h.retry(ok)
  const post = h.take('/tasks/done-1/retry')
  assert.equal(post.options!.method, 'POST')
  post.resolve({ ok: true, status: 201, json: async () => ({ taskId: 'fresh' }) })
  await h.settle()
  assert.equal(ok.inserted.length, 1)
  assert.match(ok.inserted[0].className, /retry-msg ok/)
  assert.equal(ok.inserted[0].textContent, 're-dispatched')
  assert.equal(ok.disabled, false)
  assert.equal(ok.textContent, 'retry')

  // 401 under FORGE_AUTH_TOKEN surfaces inline — not a silent no-op.
  const denied = new FakeButton('fail-1')
  await h.retry(denied)
  h.take('/tasks/fail-1/retry').resolve({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) })
  await h.settle()
  assert.match(denied.inserted[0].className, /retry-msg err/)
  assert.match(denied.inserted[0].textContent, /retry failed: HTTP 401/)
  assert.equal(denied.disabled, false)

  // A network error is also surfaced, leaving the button usable.
  const offline = new FakeButton('done-1')
  await h.retry(offline)
  h.take('/tasks/done-1/retry').reject(new Error('offline'))
  await h.settle()
  assert.match(offline.inserted[0].className, /retry-msg err/)
  assert.match(offline.inserted[0].textContent, /retry failed: offline/)
})

test('retryTask encodes the id in the POST URL', async () => {
  const h = await harness(await servedScript())
  const button = new FakeButton('task a/b')
  await h.retry(button)
  const post = h.take('/tasks/task%20a%2Fb/retry')
  assert.equal(post.options!.method, 'POST')
})
