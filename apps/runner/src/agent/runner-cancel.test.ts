import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { containmentAvailable } from './cgroup.js'

// Runs the actual runner and SQLite state transitions, using only a disposable
// root-owned fixture and the existing nobody account. It never invokes a provider.
test('cancelling actual preparation never starts the agent and cleans up the copy', {
  skip: process.getuid?.() !== 0 || process.env.FORGE_TEST_CGROUP !== '1', timeout: 15_000,
}, async () => {
  assert.equal(containmentAvailable(), true, 'root integration requires delegated cgroup v2')
  const root = mkdtempSync(join(tmpdir(), 'forge-runner-cancel-'))
  chmodSync(root, 0o711)
  const repo = join(root, 'repo'), base = join(root, 'copies'), auth = join(root, 'auth')
  mkdirSync(repo); mkdirSync(base, { mode: 0o711 }); mkdirSync(auth, { mode: 0o700 })
  writeFileSync(join(auth, 'auth.json'), '{}', { mode: 0o600 })
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repo, stdio: 'ignore' })
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  writeFileSync(join(repo, 'readme.txt'), 'fixture')
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
  process.env.ALLOWED_REPO_PATHS = root
  process.env.DATA_DIR = join(root, 'db')
  process.env.READONLY_BASE_DIR = base
  process.env.READONLY_RUN_USER = 'nobody'
  process.env.CLAUDE_RUN_USER = 'daemon'
  process.env.CODEX_RUN_USER = 'daemon'
  process.env.READONLY_CODEX_HOME = auth
  let database: { close: () => void } | undefined
  try {
    const { db } = await import('../db/schema.js'); database = db
    const { runTask, killTask, countActiveProcs } = await import('./runner.js')
    const { insertTask, getTask, updateTaskStatus } = await import('../db/queries.js')
    const task = { id: 'cancel-prep', repo, branch: 'main', prompt: 'must not execute', provider: 'codex' as const,
      readOnly: true, autoCommit: false, status: 'queued' as const, log: '', createdAt: new Date().toISOString() }
    insertTask(task)
    const emitter = new EventEmitter()
    const events: {type: string; data: string}[] = []
    emitter.on('event', event => events.push(event))
    const running = runTask(task, emitter)
    assert.equal(countActiveProcs(), 1, 'prep child is registered before yielding')
    assert.equal(killTask(task.id), true)
    updateTaskStatus(task.id, 'failed') // the actual DELETE handler transition
    await running
    assert.equal(getTask(task.id)?.status, 'failed')
    assert.equal(countActiveProcs(), 0)
    assert.equal(events.some(e => e.type === 'status' && e.data === 'running'), false)
    assert.equal(getTask(task.id)?.log.includes('[forge] starting codex'), false)
    const { readdirSync } = await import('node:fs')
    assert.deepEqual(readdirSync(base), [], 'disposable copy removed')
    assert.equal(existsSync(join(repo, 'readme.txt')), true)
    // A provisioning failure must also settle cleanly and remove its private
    // root-owned setup files without handing them to the agent account.
    rmSync(join(auth, 'auth.json'))
    const badAuth = { ...task, id: 'missing-auth' }
    insertTask(badAuth)
    await runTask(badAuth, new EventEmitter())
    assert.equal(getTask(badAuth.id)?.status, 'failed')
    assert.match(getTask(badAuth.id)?.errorMessage ?? '', /home setup failed/)
    assert.deepEqual(readdirSync(base), [])
  } finally { database?.close(); rmSync(root, { recursive: true, force: true }) }
})
