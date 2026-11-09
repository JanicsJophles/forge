import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import express from 'express'
import { rootRouter } from './root.js'
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
    for (const path of ['/health', '/capabilities', '/tasks', '/repos', '/agent-context']) {
      assert.ok(body.includes(path), `landing page links ${path}`)
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
    assert.match(body, /fetch\('\/health'/, 'landing page fetches /health client-side')
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
    for (const path of ['/health', '/capabilities', '/tasks', '/repos', '/agent-context']) {
      assert.ok(body.includes(path), `landing page links ${path}`)
    }
    assert.match(body, /href="\/dashboard"/, 'dashboard link preserved')
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
