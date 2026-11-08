import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import express, { type Express } from 'express'
import { requireBearerAuth } from './auth.js'

const TOKEN = 'test-secret-token-0123456789abcdef'

// Run `fn` against a listening server bound to an ephemeral port, then close it.
async function withServer(app: Express, fn: (base: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
  }
}

// A minimal app that exercises the middleware without spawning real tasks: the
// downstream handlers simply echo a success status so we observe passthrough.
function stubApp(token: string | undefined): Express {
  const app = express()
  app.use(requireBearerAuth(token))
  app.use(express.json())
  app.post('/tasks', (_req, res) => res.status(201).json({ taskId: 'stub' }))
  app.get('/tasks', (_req, res) => res.status(200).json([]))
  app.delete('/tasks/:id', (_req, res) => res.status(200).json({ ok: true }))
  app.use((_req, res) => res.status(404).json({ error: 'not found' }))
  return app
}

test('auth off (no token): every method passes through untouched', async () => {
  await withServer(stubApp(undefined), async base => {
    const post = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(post.status, 201)
    assert.deepEqual(await post.json(), { taskId: 'stub' })

    // A GET is open as well, and so is a stray/garbage Authorization header.
    const get = await fetch(`${base}/tasks`, { headers: { authorization: 'Bearer whatever' } })
    assert.equal(get.status, 200)
  })
})

test('auth on: mutating methods require a correct bearer token; reads stay open', async () => {
  await withServer(stubApp(TOKEN), async base => {
    // Missing header → 401, no passthrough.
    const missing = await fetch(`${base}/tasks`, { method: 'POST' })
    assert.equal(missing.status, 401)
    assert.deepEqual(await missing.json(), { error: 'unauthorized' })

    // Wrong token, wrong scheme, and bare token all → 401.
    for (const authorization of [`Bearer ${TOKEN}x`, `Basic ${TOKEN}`, TOKEN, 'Bearer ']) {
      const bad = await fetch(`${base}/tasks`, { method: 'POST', headers: { authorization } })
      assert.equal(bad.status, 401, `expected 401 for header "${authorization}"`)
    }

    // Correct token passes through → downstream 201.
    const ok = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(ok.status, 201)
    assert.deepEqual(await ok.json(), { taskId: 'stub' })

    // A case-insensitive scheme with extra whitespace still passes.
    const del = await fetch(`${base}/tasks/abc`, {
      method: 'DELETE',
      headers: { authorization: `bearer   ${TOKEN}` },
    })
    assert.equal(del.status, 200)

    // GET needs no token even with auth on.
    const read = await fetch(`${base}/tasks`)
    assert.equal(read.status, 200)
    const readWithWrong = await fetch(`${base}/tasks`, { headers: { authorization: 'Bearer nope' } })
    assert.equal(readWithWrong.status, 200)
  })
})

test('real POST /tasks is gated: 401 without token creates no task; correct token reaches the handler', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'forge-auth-'))
  const previous = {
    DATA_DIR: process.env.DATA_DIR,
    ALLOWED_REPO_PATHS: process.env.ALLOWED_REPO_PATHS,
    DOTENV_CONFIG_PATH: process.env.DOTENV_CONFIG_PATH,
  }
  process.env.DATA_DIR = dataDir
  process.env.ALLOWED_REPO_PATHS = dataDir
  process.env.DOTENV_CONFIG_PATH = '/dev/null'

  try {
    const { tasksRouter } = await import('./tasks.js')
    const { db } = await import('../db/schema.js')
    try {
      const app = express()
      app.use(requireBearerAuth(TOKEN))
      app.use(express.json())
      app.use('/tasks', tasksRouter)
      app.use((_req, res) => res.status(404).json({ error: 'not found' }))

      await withServer(app, async base => {
        // No token → 401 from the middleware, body never parsed, no row written.
        const blocked = await fetch(`${base}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo: dataDir, prompt: 'hello' }),
        })
        assert.equal(blocked.status, 401)
        assert.deepEqual(await blocked.json(), { error: 'unauthorized' })

        // Correct token clears the gate and reaches the handler: an empty body
        // yields the handler's own 400 (not a 401), proving passthrough without
        // spawning a provider.
        const passed = await fetch(`${base}/tasks`, {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: '{}',
        })
        assert.equal(passed.status, 400)

        assert.equal(
          (db.prepare('SELECT count(*) AS count FROM tasks').get() as { count: number }).count,
          0,
        )
      })
    } finally {
      db.close()
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dataDir, { recursive: true, force: true })
  }
})
