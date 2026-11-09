import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import type { spawn } from 'node:child_process'
import test from 'node:test'
import { checkCodexLogin, executionIdentity } from './provider.js'

const excluded = [
  'FORGE_AUTH_TOKEN', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY',
  'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
]

test('provider identities and Codex login omit runner and provider credentials', async t => {
  const originalEnv = process.env
  // Replace the entire environment: assertions only inspect sentinel values.
  const parentEnv = {
    ...Object.fromEntries(excluded.map(key => [key, `sentinel-${key}`])),
    HOME: '/sentinel/service', USER: 'service', LOGNAME: 'service', PATH: '/sentinel/bin',
  }
  process.env = { ...parentEnv }
  t.mock.method(os, 'userInfo', () => ({
    username: 'sentinel-agent', uid: 1001, gid: 1002,
    homedir: '/sentinel/agent', shell: '/bin/sh',
  }))
  syncBuiltinESMExports()
  try {
    for (const provider of ['claude', 'codex']) {
      // Both provider launch paths use this same identity builder.
      const identity = executionIdentity('sentinel-agent')
      assert.equal(identity.uid, 1001, provider)
      assert.equal(identity.gid, 1002, provider)
      assert.deepEqual(identity.env, {
        HOME: '/sentinel/agent', USER: 'sentinel-agent',
        LOGNAME: 'sentinel-agent', PATH: '/sentinel/bin',
      })
      for (const key of excluded) assert.equal(Object.hasOwn(identity.env, key), false, key)
      assert.deepEqual(process.env, parentEnv)
    }

    const identity = executionIdentity('sentinel-agent')
    const child = new EventEmitter()
    const login = checkCodexLogin(identity, {
      spawn: ((command, args, options) => {
        assert.equal(command, 'codex')
        assert.deepEqual(args, ['login', 'status'])
        assert.deepEqual(options, { ...identity, stdio: 'ignore' })
        for (const key of excluded) assert.equal(Object.hasOwn(options.env!, key), false, key)
        return child
      }) as typeof spawn,
      setTimeout: () => 123 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => {},
    })
    child.emit('close', 0, null)
    await login
    assert.deepEqual(process.env, parentEnv)
  } finally {
    process.env = originalEnv
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})
