import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import express from 'express'
import { capabilitiesRouter } from './capabilities.js'

// Capabilities discovery lives only at the documented root mount. The tasks
// router must NOT re-mount it: a prior `tasksRouter.use(capabilitiesRouter)`
// leaked an undocumented GET /tasks/capabilities that diverged from the API.
test('GET /capabilities is 200 at root; GET /tasks/capabilities is 404', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-caps-mount-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = path.join(directory, 'no-env-file')
  t.after(() => rm(directory, { recursive: true, force: true }))

  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  t.after(() => db.close())

  const app = express()
  app.use(capabilitiesRouter)
  app.use('/tasks', tasksRouter)
  app.use((_req, res) => { res.status(404).json({ error: 'not found' }) })

  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve())
    server.closeAllConnections()
  }))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // Documented root mount still serves the versioned contract.
  const root = await fetch(`${base}/capabilities`)
  assert.equal(root.status, 200)
  assert.match(root.headers.get('content-type') ?? '', /application\/json/)
  const body = await root.json() as { providerSelectionVersion: number }
  assert.equal(body.providerSelectionVersion, 1)

  // The duplicate /tasks mount is gone: it now falls through to the 404 handler.
  const leaked = await fetch(`${base}/tasks/capabilities`)
  assert.equal(leaked.status, 404)
  assert.deepEqual(await leaked.json(), { error: 'not found' })
})
