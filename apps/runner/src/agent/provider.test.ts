import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Agents run untrusted prompts and their output is readable by anyone via the
// open GET /tasks/:id, so the runner token must never reach their environment.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-provider-'))
const TOKEN = 'p'.repeat(40)
Object.assign(process.env, { DATA_DIR: root, ALLOWED_REPO_PATHS: root, FORGE_RUNNER_TOKEN: TOKEN, FORGE_RUNNER_TOKEN_BRIDGE: `${TOKEN}b` })

const { config } = await import('../config.js')
const { executionIdentity } = await import('./provider.js')

test('config takes every runner token out of the process environment', () => {
  assert.deepEqual(config.runnerTokens, { default: TOKEN, bridge: `${TOKEN}b` })
  assert.equal(process.env.FORGE_RUNNER_TOKEN, undefined)
  assert.equal(process.env.FORGE_RUNNER_TOKEN_BRIDGE, undefined)
})

test('agent child environment never carries the runner token', () => {
  // Even if something puts it back into process.env later.
  process.env.FORGE_RUNNER_TOKEN = TOKEN
  process.env.FORGE_RUNNER_TOKEN_MAC = TOKEN
  try {
    const { env } = executionIdentity(os.userInfo().username)
    assert.deepEqual(Object.keys(env).filter(key => key.startsWith('FORGE_RUNNER_TOKEN')), [])
    assert.ok(!Object.values(env).includes(TOKEN))
  } finally {
    delete process.env.FORGE_RUNNER_TOKEN
    delete process.env.FORGE_RUNNER_TOKEN_MAC
  }
})
