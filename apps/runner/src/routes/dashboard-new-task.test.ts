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
  return { elements, requests, el, take, resolveWith, submit, settle, timers }
}

test('launcher populates the repo select from GET /repos with escaped labels', async () => {
  const h = await harness(await servedScript())
  // The load-time wiring issued exactly one /repos read.
  assert.equal(h.requests.filter((r) => r.url.includes('/repos')).length, 1)

  await h.resolveWith('/repos', {
    ok: true,
    json: async () => [
      { name: 'forge', path: '/opt/repos/fleet-forge', currentBranch: 'fleet/next' },
      // Hostile name + path must be neutralized before reaching the DOM.
      { name: '"><img src=x onerror=alert(1)>', path: '/opt/repos/<evil>' },
      // A blank name falls back to the path as the label.
      { name: '', path: '/opt/repos/brain' },
      // Entries without a usable path are skipped entirely.
      { name: 'skip', path: '' },
    ],
  })

  const html = h.el('launchRepo').innerHTML
  assert.match(html, /<option value="\/opt\/repos\/fleet-forge">forge<\/option>/)
  assert.match(html, /<option value="\/opt\/repos\/brain">\/opt\/repos\/brain<\/option>/)
  assert.ok(!html.includes('<img'))
  assert.match(html, /&lt;img src=x/)
  assert.match(html, /value="\/opt\/repos\/&lt;evil&gt;"/)
  // The skipped (path-less) entry contributes no option.
  assert.ok(!html.includes('>skip<'))
})

test('a failed /repos load degrades to a static message, never throwing', async () => {
  const h = await harness(await servedScript())
  await h.resolveWith('/repos', { ok: false, status: 500, json: async () => ({}) })
  assert.match(h.el('launchRepo').innerHTML, /could not load repositories/)
})

test('submitting POSTs JSON to /tasks and clears the prompt on 201', async () => {
  const h = await harness(await servedScript())
  await h.resolveWith('/repos', { ok: true, json: async () => [{ name: 'forge', path: '/opt/repos/fleet-forge', currentBranch: 'fleet/next' }] })

  h.el('launchRepo').value = '/opt/repos/fleet-forge'
  h.el('launchPrompt').value = 'do a thing'
  h.el('launchProvider').value = 'codex'
  h.el('launchAutoCommit').checked = true
  h.el('launchSubmit').textContent = 'Launch task' // server-rendered initial label

  await h.submit()
  const post = h.take('/tasks')
  assert.equal(post.options!.method, 'POST')
  assert.equal(post.options!.headers!['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(post.options!.body!), {
    repo: '/opt/repos/fleet-forge',
    branch: 'fleet/next',
    prompt: 'do a thing',
    provider: 'codex',
    autoCommit: true,
  })

  post.resolve({ ok: true, status: 201, json: async () => ({ taskId: 'abc' }) })
  await h.settle()
  // 201: prompt cleared, button re-enabled, label restored, no error shown.
  assert.equal(h.el('launchPrompt').value, '')
  assert.equal(h.el('launchErr').textContent, '')
  assert.equal(h.el('launchSubmit').textContent, 'Launch task')
  assert.equal(h.el('launchSubmit').disabled, false)
})

test('a non-empty model is trimmed and included in the POST body', async () => {
  const h = await harness(await servedScript())
  await h.resolveWith('/repos', { ok: true, json: async () => [{ name: 'forge', path: '/opt/repos/fleet-forge', currentBranch: 'fleet/next' }] })

  h.el('launchRepo').value = '/opt/repos/fleet-forge'
  h.el('launchPrompt').value = 'do a thing'
  h.el('launchProvider').value = 'claude'
  h.el('launchModel').value = '  claude-opus-4-6  '

  await h.submit()
  const post = h.take('/tasks')
  assert.deepEqual(JSON.parse(post.options!.body!), {
    repo: '/opt/repos/fleet-forge',
    branch: 'fleet/next',
    prompt: 'do a thing',
    provider: 'claude',
    autoCommit: false,
    model: 'claude-opus-4-6',
  })
  post.resolve({ ok: true, status: 201, json: async () => ({ taskId: 'abc' }) })
  await h.settle()
})

test('a blank / whitespace-only model omits the model field entirely', async () => {
  const h = await harness(await servedScript())
  await h.resolveWith('/repos', { ok: true, json: async () => [{ name: 'forge', path: '/opt/repos/fleet-forge', currentBranch: 'fleet/next' }] })

  h.el('launchRepo').value = '/opt/repos/fleet-forge'
  h.el('launchPrompt').value = 'do a thing'
  h.el('launchProvider').value = 'claude'
  h.el('launchModel').value = '   '

  await h.submit()
  const post = h.take('/tasks')
  const body = JSON.parse(post.options!.body!)
  // No model key at all — the server applies the provider (claude) default.
  assert.ok(!('model' in body), 'blank model must not add a model field')
  assert.deepEqual(body, {
    repo: '/opt/repos/fleet-forge',
    branch: 'fleet/next',
    prompt: 'do a thing',
    provider: 'claude',
    autoCommit: false,
  })
  post.resolve({ ok: true, status: 201, json: async () => ({ taskId: 'abc' }) })
  await h.settle()
})

test('a server 400 for an invalid model surfaces inline, never silently', async () => {
  const h = await harness(await servedScript())
  await h.resolveWith('/repos', { ok: true, json: async () => [{ name: 'forge', path: '/opt/repos/fleet-forge', currentBranch: 'fleet/next' }] })

  h.el('launchRepo').value = '/opt/repos/fleet-forge'
  h.el('launchPrompt').value = 'keep me'
  h.el('launchModel').value = 'bad model!'
  h.el('launchSubmit').textContent = 'Launch task'

  await h.submit()
  // The server rejects the invalid model shape with 400.
  h.take('/tasks').resolve({ ok: false, status: 400, json: async () => ({ error: 'invalid model' }) })
  await h.settle()
  assert.match(h.el('launchErr').textContent, /launch failed: HTTP 400/)
  // The prompt (and the typed model) are left intact so the operator can fix it.
  assert.equal(h.el('launchPrompt').value, 'keep me')
  assert.equal(h.el('launchSubmit').disabled, false)
})

test('a non-2xx response surfaces inline and leaves the typed prompt intact', async () => {
  const h = await harness(await servedScript())
  await h.resolveWith('/repos', { ok: true, json: async () => [{ name: 'forge', path: '/opt/repos/fleet-forge', currentBranch: 'fleet/next' }] })
  h.el('launchRepo').value = '/opt/repos/fleet-forge'
  h.el('launchPrompt').value = 'keep me'
  h.el('launchSubmit').textContent = 'Launch task'

  await h.submit()
  // 401 when FORGE_AUTH_TOKEN is set (or 400/409/429/507).
  h.take('/tasks').resolve({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) })
  await h.settle()
  assert.match(h.el('launchErr').textContent, /launch failed: HTTP 401/)
  assert.equal(h.el('launchPrompt').value, 'keep me')
  assert.equal(h.el('launchSubmit').textContent, 'Launch task')
  assert.equal(h.el('launchSubmit').disabled, false)
})

test('a network error surfaces inline and leaves the typed prompt intact', async () => {
  const h = await harness(await servedScript())
  await h.resolveWith('/repos', { ok: true, json: async () => [{ name: 'forge', path: '/opt/repos/fleet-forge', currentBranch: 'fleet/next' }] })
  h.el('launchRepo').value = '/opt/repos/fleet-forge'
  h.el('launchPrompt').value = 'keep me'

  await h.submit()
  h.take('/tasks').reject(new Error('offline'))
  await h.settle()
  assert.match(h.el('launchErr').textContent, /launch failed: offline/)
  assert.equal(h.el('launchPrompt').value, 'keep me')
})

test('submitting with no repo or blank prompt validates without a /tasks POST', async () => {
  const h = await harness(await servedScript())
  await h.resolveWith('/repos', { ok: true, json: async () => [{ name: 'forge', path: '/opt/repos/fleet-forge', currentBranch: 'fleet/next' }] })

  // No repo selected.
  h.el('launchRepo').value = ''
  h.el('launchPrompt').value = 'has a prompt'
  await h.submit()
  assert.match(h.el('launchErr').textContent, /select a repository/)
  assert.equal(h.requests.filter((r) => r.url.includes('/tasks')).length, 0)

  // Repo set, but whitespace-only prompt.
  h.el('launchRepo').value = '/opt/repos/fleet-forge'
  h.el('launchPrompt').value = '   '
  await h.submit()
  assert.match(h.el('launchErr').textContent, /prompt is required/)
  assert.equal(h.requests.filter((r) => r.url.includes('/tasks')).length, 0)
})

for (const failure of ['HTTP', 'headers deadline', 'body deadline', 'malformed']) {
  test(`repository retry preserves drafts and blocks submission after ${failure}`, async () => {
    const h = await harness(await servedScript())
    const repos = [{ path: '/repo', currentBranch: 'fleet/next' }]
    await h.resolveWith('/repos', { ok: true, json: async () => repos })
    h.el('launchRepo').value = '/repo'
    h.el('launchPrompt').value = 'keep draft'
    h.el('launchProvider').value = 'codex'
    h.el('launchModel').value = 'custom-model'
    h.el('launchAutoCommit').checked = true
    h.el('authToken').value = 'draft-token'
    h.el('launchSuccess').textContent = 'previous launch'
    h.el('reloadRepos').onclick()
    h.el('reloadRepos').onclick()
    assert.equal(h.requests.filter(r => r.url === '/repos').length, 1)
    assert.equal(h.el('reloadRepos').disabled, true)
    const pending = h.take('/repos')
    assert.equal(h.el('launchSuccess').textContent, 'previous launch')
    await h.submit()
    assert.equal(h.requests.filter(r => r.options?.method === 'POST').length, 0)
    if (failure === 'HTTP') pending.resolve({ ok: false, status: 503 })
    if (failure === 'malformed') pending.resolve({ ok: true, json: async () => ({}) })
    let finishBody!: (value: unknown) => void
    if (failure === 'body deadline') {
      pending.resolve({ ok: true, json: () => new Promise(resolve => { finishBody = resolve }) })
      await h.settle()
    }
    if (failure.includes('deadline')) {
      for (const timer of [...h.timers.values()]) if (timer.ms === 10000) timer.fn()
    }
    await h.settle()
    assert.match(h.el('repoDiscoveryStatus').textContent, /failed/)
    assert.equal(h.el('reloadRepos').disabled, false)
    await h.submit()
    assert.equal(h.requests.filter(r => r.options?.method === 'POST').length, 0)
    const feedback = h.el('launchErr').textContent
    h.el('reloadRepos').onclick()
    await h.resolveWith('/repos', { ok: true, json: async () => repos })
    assert.equal(h.el('launchErr').textContent, feedback)
    if (failure === 'headers deadline') pending.resolve({ ok: true, json: async () => [] })
    if (failure === 'body deadline') finishBody([])
    await h.settle()
    assert.equal(h.el('launchRepo').value, '/repo')
    assert.equal(h.el('launchPrompt').value, 'keep draft')
    assert.equal(h.el('launchProvider').value, 'codex')
    assert.equal(h.el('launchModel').value, 'custom-model')
    assert.equal(h.el('launchAutoCommit').checked, true)
    assert.equal(h.el('authToken').value, 'draft-token')
    await h.submit()
    const post = h.take('/tasks')
    assert.equal(JSON.parse(post.options!.body!).branch, 'fleet/next')
    post.resolve({ ok: true, status: 201, json: async () => ({ taskId: 'retry-task' }) })
    await h.settle()
  })
}

test('repository refresh requires a new choice when the selected checkout disappears', async () => {
  const h = await harness(await servedScript())
  await h.resolveWith('/repos', { ok: true, json: async () => [{ path: '/old', currentBranch: 'old' }] })
  h.el('launchRepo').value = '/old'
  h.el('launchPrompt').value = 'keep draft'
  for (const repos of [[{ path: '/new', currentBranch: 'new' }], []]) {
    h.el('reloadRepos').onclick()
    await h.resolveWith('/repos', { ok: true, json: async () => repos })
    assert.equal(h.el('launchRepo').value, '')
    assert.equal(h.el('launchPrompt').value, 'keep draft')
    await h.submit()
    assert.equal(h.requests.filter(r => r.options?.method === 'POST').length, 0)
  }
  assert.match(h.el('repoDiscoveryStatus').textContent, /No repositories/)
})
