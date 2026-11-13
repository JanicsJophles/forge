import assert from 'node:assert/strict'
import { execFileSync, type spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkCodexLogin, executionIdentity } from './provider.js'

const selectors = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES',
]
const credentials = [
  'FORGE_AUTH_TOKEN', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY',
  'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
]

test('provider environments and login discard checkout selectors without changing the parent or Git auth', async t => {
  const originalEnv = process.env
  const preserved = {
    PATH: '/sentinel/bin', GIT_ASKPASS: '/sentinel/askpass', SSH_ASKPASS: '/sentinel/ssh-askpass',
    GIT_SSH_COMMAND: 'sentinel-ssh', GIT_TERMINAL_PROMPT: '1',
    SSH_AUTH_SOCK: '/sentinel/socket', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'sentinel-helper',
    GIT_AUTHOR_NAME: 'Sentinel Author',
  }
  const parent = {
    ...preserved, HOME: '/sentinel/service', USER: 'service', LOGNAME: 'service',
    ...Object.fromEntries([...selectors, ...credentials].map(key => [key, `sentinel-${key}`])),
  }
  process.env = { ...parent }
  t.mock.method(os, 'userInfo', () => ({
    username: 'sentinel-agent', uid: 1001, gid: 1002, homedir: '/sentinel/agent', shell: '/bin/sh',
  }))
  syncBuiltinESMExports()
  try {
    for (const provider of ['claude', 'codex']) {
      const identity = executionIdentity('sentinel-agent')
      assert.deepEqual(identity, {
        uid: 1001, gid: 1002,
        env: { ...preserved, HOME: '/sentinel/agent', USER: 'sentinel-agent', LOGNAME: 'sentinel-agent' },
      }, provider)
      for (const key of [...selectors, ...credentials]) assert.equal(Object.hasOwn(identity.env, key), false, key)
      assert.deepEqual(process.env, parent)
    }
    const identity = executionIdentity('sentinel-agent')
    const child = new EventEmitter()
    const login = checkCodexLogin(identity, {
      spawn: ((command, args, options) => {
        assert.equal(command, 'codex')
        assert.deepEqual(args, ['login', 'status'])
        assert.deepEqual(options, { ...identity, stdio: 'ignore' })
        for (const key of selectors) assert.equal(Object.hasOwn(options.env!, key), false, key)
        return child
      }) as typeof spawn,
      setTimeout: () => 123 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => {},
    })
    child.emit('close', 0, null)
    await login
    assert.deepEqual(process.env, parent)
  } finally {
    process.env = originalEnv
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('child Git discovers the admitted cwd despite parent selectors pointing to another disposable repo', t => {
  const originalEnv = process.env
  const root = mkdtempSync(join(os.tmpdir(), 'forge-provider-git-'))
  const home = join(root, 'home')
  mkdirSync(home)
  // No inherited Git config, credentials, hooks or checkout paths enter these children.
  const cleanEnv = { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (cwd: string, env: NodeJS.ProcessEnv, args: string[]) => execFileSync('git', args, {
    cwd, env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  t.mock.method(os, 'userInfo', () => ({
    username: 'sentinel-agent', uid: 1001, gid: 1002, homedir: home, shell: '/bin/sh',
  }))
  syncBuiltinESMExports()
  try {
    const admitted = join(root, 'admitted')
    const other = join(root, 'other')
    for (const repo of [admitted, other]) git(root, cleanEnv, ['init', '--template=', repo])
    const otherGit = join(other, '.git')
    process.env = {
      ...cleanEnv, GIT_DIR: otherGit, GIT_WORK_TREE: other, GIT_COMMON_DIR: otherGit,
      GIT_INDEX_FILE: join(otherGit, 'index'), GIT_OBJECT_DIRECTORY: join(otherGit, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(otherGit, 'objects'), GIT_CEILING_DIRECTORIES: root,
    }
    const parent = { ...process.env }
    assert.equal(git(admitted, parent, ['rev-parse', '--show-toplevel']), other)
    for (const provider of ['claude', 'codex']) {
      const { env } = executionIdentity('sentinel-agent')
      assert.equal(git(admitted, env, ['rev-parse', '--show-toplevel']), admitted, provider)
      assert.equal(git(admitted, env, ['rev-parse', '--absolute-git-dir']), join(admitted, '.git'), provider)
      assert.deepEqual(process.env, parent)
    }
  } finally {
    process.env = originalEnv
    t.mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})
