import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { rootRouter, acceptingLabel } from './root.js'
import { version } from '../version.js'
import { requireBearerAuth } from './auth.js'

function startApp(app: express.Express) {
  const server = app.listen(0, '127.0.0.1')
  return {
    server,
    ready: new Promise<string>(resolve =>
      server.once('listening', () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      ),
    ),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve())),
      ),
  }
}

test('GET / returns an HTML landing page with version and a dashboard link', async () => {
  const app = express()
  app.use(rootRouter)
  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' })
  })
  const { ready, close } = startApp(app)
  try {
    const base = await ready
    const response = await fetch(base + '/')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/html/)
    const body = await response.text()
    assert.ok(body.includes(version), 'landing page lists the build version')
    assert.match(body, /href="\/dashboard"/)
    // The documented endpoints are signposted.
    for (const path of ['/health', '/capabilities', '/tasks', '/history', '/repos', '/agent-context']) {
      assert.ok(body.includes(`href="${path}"`), `landing page links ${path}`)
    }
    // The root route does not swallow unknown paths.
    const unknown = await fetch(base + '/nope')
    assert.equal(unknown.status, 404)
    assert.deepEqual(await unknown.json(), { error: 'not found' })
  } finally {
    await close()
  }
})

test('GET / embeds a client-side fetch of /health and keeps the static fallback', async () => {
  const app = express()
  app.use(rootRouter)
  const { ready, close } = startApp(app)
  try {
    const base = await ready
    const response = await fetch(base + '/')
    assert.equal(response.status, 200)
    const body = await response.text()
    // The live status block fetches /health on each page load.
    assert.match(body, /readJson\('\/health'/, 'landing page fetches /health client-side')
    // The rendered fields the script fills in are present as targets.
    for (const id of ['accepting', 'slots', 'uptime', 'live-version']) {
      assert.ok(body.includes(`id="${id}"`), `status field #${id} is present`)
    }
    // Server values are written via textContent (never innerHTML) so a hostile
    // /health payload cannot inject markup.
    assert.match(body, /textContent/, 'script renders values with textContent')
    assert.doesNotMatch(body, /innerHTML/, 'script never uses innerHTML')
    // Static fallback: version + every documented endpoint still render without
    // JS, so a failed fetch (or JS off) never leaves a blank page.
    assert.ok(body.includes(version), 'static render still lists the build version')
    for (const path of ['/health', '/capabilities', '/tasks', '/history', '/repos', '/agent-context']) {
      assert.ok(body.includes(`href="${path}"`), `landing page links ${path}`)
    }
    assert.match(body, /href="\/dashboard"/, 'dashboard link preserved')
  } finally {
    await close()
  }
})

test('acceptingLabel maps each notAcceptingReason to a human suffix', () => {
  // Accepting: always 'yes', reason is ignored.
  assert.equal(acceptingLabel(true, null), 'yes')
  assert.equal(acceptingLabel(true, 'disk'), 'yes')
  // Each known refusal code appends its human reason.
  assert.equal(acceptingLabel(false, 'concurrency'), 'no (at capacity)')
  assert.equal(acceptingLabel(false, 'disk'), 'no (low disk)')
  assert.equal(acceptingLabel(false, 'dataDisk'), 'no (low data-disk)')
  assert.equal(acceptingLabel(false, 'unknown'), 'no (disk unmeasured)')
  // Missing or unrecognised code degrades to a bare 'no'.
  assert.equal(acceptingLabel(false, null), 'no')
  assert.equal(acceptingLabel(false, 'bogus'), 'no')
})

test('GET / embeds the reason-label map so the page can show WHY it refuses', async () => {
  const app = express()
  app.use(rootRouter)
  const { ready, close } = startApp(app)
  try {
    const base = await ready
    const body = await (await fetch(base + '/')).text()
    // The client script reads notAcceptingReason and carries the human labels.
    assert.match(body, /notAcceptingReason/, 'script reads notAcceptingReason')
    for (const label of ['at capacity', 'low disk', 'low data-disk', 'disk unmeasured']) {
      assert.ok(body.includes(label), `reason label "${label}" is embedded`)
    }
  } finally {
    await close()
  }
})

test('GET / stays open (200) even when a bearer token is configured', async () => {
  const app = express()
  // Mirror production ordering: the bearer gate runs before every route.
  app.use(requireBearerAuth('s3cret-token'))
  app.use(rootRouter)
  const { ready, close } = startApp(app)
  try {
    const base = await ready
    // No Authorization header — a read must still succeed.
    const response = await fetch(base + '/')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/html/)
  } finally {
    await close()
  }
})

async function renderRecentTasks(payload: unknown, failure?: 'http' | 'network') {
  const app = express()
  app.use(rootRouter)
  const { ready, close } = startApp(app)
  let body: string
  try {
    body = await (await fetch((await ready) + '/')).text()
  } finally {
    await close()
  }
  assert.match(body, /<h2>Recent tasks<\/h2>/)
  assert.match(body, /<li>recent tasks unavailable<\/li>/)
  assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML/)
  class Element {
    textContent = ''
    children: Element[] = []
    appendChild(child: Element) { this.children.push(child) }
  }
  const list = new Element()
  const requests: string[] = []
  runInNewContext(body.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: {
      getElementById: (id: string) => id === 'recent-tasks' ? list : new Element(),
      createElement: (tag: string) => {
        assert.equal(tag, 'li')
        return new Element()
      },
    },
    AbortController,
    clearTimeout: () => {},
    setTimeout: () => 0,
    fetch: async (url: string) => {
      requests.push(url)
      if (url === '/health') return { ok: true, json: async () => ({}) }
      if (failure === 'network') throw new Error('offline')
      return { ok: failure !== 'http', status: 503, json: async () => payload }
    },
  })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(requests, ['/tasks?limit=5', '/health'])
  return list
}

test('landing script renders five compact task rows as literal text', async () => {
  const task = { id: '12345678-abcd', repo: '/opt/repos/<img src=x onerror=alert(1)>/', status: '<b>running</b>' }
  const list = await renderRecentTasks(Array.from({ length: 6 }, () => task))
  assert.equal(list.children.length, 5)
  assert.equal(list.children[0].textContent, '12345678 — <img src=x onerror=alert(1)> — <b>running</b>')
})

test('landing script handles an empty task list', async () => {
  const list = await renderRecentTasks([])
  assert.equal(list.children.length, 1)
  assert.equal(list.children[0].textContent, 'No recent tasks')
})

test('landing script handles task request and payload failures', async () => {
  for (const failure of ['http', 'network'] as const) {
    const list = await renderRecentTasks([], failure)
    assert.equal(list.textContent, 'recent tasks unavailable')
  }
  const list = await renderRecentTasks({ error: 'unexpected response' })
  assert.equal(list.textContent, 'recent tasks unavailable')
})
