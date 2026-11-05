import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import express from 'express'
import type { AgentTask } from '@forge/shared'

test('task branch claims reflect the checkout before any creation side effects', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forge-branch-'))
  const repo = path.join(root, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q', '-b', 'actual')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'init')
  process.env.DATA_DIR = path.join(root, 'data')
  process.env.ALLOWED_REPO_PATHS = root
  process.env.MIN_FREE_DISK_MB = '0'
  process.env.DOTENV_CONFIG_PATH = path.join(root, 'no-env-file')

  const { createTaskHandler } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  const inserted: AgentTask[] = []
  let emitters = 0
  let runs = 0
  const app = express().use(express.json()).post('/tasks', createTaskHandler({
    insertTask: task => { inserted.push(task) },
    createEmitter: () => { emitters++; return new EventEmitter() },
    runTask: async () => { runs++ },
  }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as import('node:net').AddressInfo
  async function post(extra: Record<string, unknown>) {
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, prompt: 'test only', ...extra }),
    })
    return { status: response.status, body: await response.json() }
  }
  function counts() { return [inserted.length, emitters, runs] }

  try {
    for (const extra of [{ branch: 'actual' }, {}]) {
      assert.equal((await post(extra)).status, 201)
      assert.equal(inserted.at(-1)?.branch, 'actual')
    }
    assert.deepEqual(counts(), [2, 2, 2])
    const mismatch = await post({ branch: 'fleet/next' })
    assert.equal(mismatch.status, 409)
    assert.deepEqual(mismatch.body, {
      error: 'requested branch does not match the current checkout',
      requested: 'fleet/next', actual: 'actual',
    })
    assert.equal(git('branch', '--show-current'), 'actual')
    assert.deepEqual(counts(), [2, 2, 2])

    for (const branch of ['', '  ', null, false, 123, {}, [], ['actual']]) {
      const invalid = await post({ branch })
      assert.equal(invalid.status, 400, JSON.stringify(branch))
      assert.match(invalid.body.error, /branch must be a nonempty string/)
      assert.deepEqual(counts(), [2, 2, 2])
    }
    git('checkout', '--detach', '-q')
    for (const extra of [{}, { branch: 'actual' }, { branch: 'HEAD' }]) {
      const detached = await post(extra)
      assert.equal(detached.status, 400)
      assert.match(detached.body.error, /detached HEAD/)
      assert.deepEqual(counts(), [2, 2, 2])
    }
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
