import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import express from 'express'
import { capabilitiesRouter } from './capabilities.js'

test('root and legacy discovery return the same static contract; unknown paths stay 404', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'forge-capabilities-'))
  const previous = {
    DATA_DIR: process.env.DATA_DIR,
    ALLOWED_REPO_PATHS: process.env.ALLOWED_REPO_PATHS,
    DOTENV_CONFIG_PATH: process.env.DOTENV_CONFIG_PATH,
  }
  process.env.DATA_DIR = dataDir
  process.env.ALLOWED_REPO_PATHS = dataDir
  process.env.DOTENV_CONFIG_PATH = '/dev/null'

  try {
    // Import only after isolating the database; never import the production listener.
    const { tasksRouter } = await import('./tasks.js')
    const { db } = await import('../db/schema.js')
    try {
      const app = express()
      app.use(capabilitiesRouter)
      app.use('/tasks', tasksRouter)
      app.use((_req, res) => { res.status(404).json({ error: 'not found' }) })
      const server = app.listen(0, '127.0.0.1')
      try {
        await new Promise<void>(resolve => server.once('listening', resolve))
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        for (const route of ['/capabilities', '/tasks/capabilities']) {
          const response = await fetch(base + route)
          assert.equal(response.status, 200)
          assert.match(response.headers.get('content-type') ?? '', /application\/json/)
          assert.deepEqual(await response.json(), {
            providerSelectionVersion: 1, providers: ['claude', 'codex'],
          })
        }
        for (const route of ['/unknown', '/capabilities/unknown', '/tasks/capabilities/unknown']) {
          const response = await fetch(base + route)
          assert.equal(response.status, 404)
          assert.deepEqual(await response.json(), { error: 'not found' })
        }
        assert.equal((db.prepare('SELECT count(*) AS count FROM tasks').get() as { count: number }).count, 0)
      } finally {
        await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
      }
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
