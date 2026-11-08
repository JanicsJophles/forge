import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import express from 'express'

// Lives in its own file (hence its own process) so FORGE_AUTH_TOKEN is in the
// environment before the config singleton is first imported. capabilities.test.ts
// covers the token-unset case (authRequired:false); this covers token-set.
test('GET /capabilities reports authRequired:true when a token is configured', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'forge-caps-auth-'))
  const previous = {
    DATA_DIR: process.env.DATA_DIR,
    ALLOWED_REPO_PATHS: process.env.ALLOWED_REPO_PATHS,
    DOTENV_CONFIG_PATH: process.env.DOTENV_CONFIG_PATH,
    FORGE_AUTH_TOKEN: process.env.FORGE_AUTH_TOKEN,
  }
  process.env.DATA_DIR = dataDir
  process.env.ALLOWED_REPO_PATHS = dataDir
  process.env.DOTENV_CONFIG_PATH = '/dev/null'
  process.env.FORGE_AUTH_TOKEN = 'test-secret-token-0123456789abcdef'

  try {
    // Import config AFTER the token is in the environment so the singleton reads it.
    const { config } = await import('../config.js')
    assert.equal(config.authToken, 'test-secret-token-0123456789abcdef')
    const { capabilitiesRouter } = await import('./capabilities.js')

    const app = express()
    app.use(capabilitiesRouter)
    const server = app.listen(0, '127.0.0.1')
    try {
      await new Promise<void>(resolve => server.once('listening', resolve))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const response = await fetch(`${base}/capabilities`)
      assert.equal(response.status, 200)
      const body = (await response.json()) as { authRequired: boolean }
      assert.equal(body.authRequired, true)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dataDir, { recursive: true, force: true })
  }
})
