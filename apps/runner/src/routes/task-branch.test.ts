import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import express from 'express'

test('POST /tasks validates the branch claim against the checkout before admitting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-branch-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  childProcess.execFileSync('git', ['init', '-q', repo])
  const git = (...args: string[]) =>
    childProcess.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd: repo,
      stdio: 'pipe',
    })
  git('commit', '--allow-empty', '-qm', 'init')
  // Read the checkout's real branch so the test does not depend on whether this
  // box defaults new repositories to main or master.
  const checkoutBranch = childProcess
    .execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' })
    .trim()

  process.env.DATA_DIR = path.join(root, 'data')
  process.env.ALLOWED_REPO_PATHS = root
  process.env.MAX_CONCURRENT_TASKS = '10'
  process.env.MIN_FREE_DISK_MB = '1'
  process.env.CODEX_RUN_USER = 'fake'

  const probes: EventEmitter[] = []
  const originalSpawn = childProcess.spawn
  const originalExecFile = childProcess.execFileSync
  // Only Git discovery runs real child processes, against this temporary repo.
  // The fake provider login stays pending until explicitly closed.
  childProcess.execFileSync = ((file: string, args: string[], options: object) =>
    file === 'git'
      ? originalExecFile(file, args, options)
      : 'fake:x:1234:1234::/tmp:/bin/sh') as typeof childProcess.execFileSync
  childProcess.spawn = (() => {
    const probe = new EventEmitter()
    Object.assign(probe, { kill: () => true })
    probes.push(probe)
    return probe
  }) as typeof childProcess.spawn
  syncBuiltinESMExports()

  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  const { getTask } = await import('../db/queries.js')
  const { getEmitter } = await import('../agent/stream.js')
  const app = express().use(express.json()).use('/tasks', tasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as import('node:net').AddressInfo
  async function post(body: Record<string, unknown>) {
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, prompt: 'test', provider: 'codex', ...body }),
    })
    return { status: response.status, body: (await response.json()) as { taskId?: string; error?: string } }
  }

  try {
    // A claim that does not match the checkout is rejected with a static 409 and
    // leaks no Git output, and no task row or agent is created.
    const mismatch = await post({ branch: `${checkoutBranch}-nope` })
    assert.equal(mismatch.status, 409)
    assert.equal(mismatch.body.error, 'requested branch does not match the repository checkout')
    assert.equal(mismatch.body.taskId, undefined)
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 0)
    assert.equal(probes.length, 0)

    // An empty / non-string branch is rejected before any task is created.
    for (const branch of ['', '   ', 42, null]) {
      const bad = await post({ branch })
      assert.equal(bad.status, 400, `branch ${JSON.stringify(branch)} should be rejected`)
      assert.equal(bad.body.error, 'branch must be a non-empty string')
    }
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 0)
    assert.equal(probes.length, 0)

    // A claim that matches the checkout is admitted and records that branch.
    const matched = await post({ branch: checkoutBranch })
    assert.equal(matched.status, 201)
    assert.ok(matched.body.taskId)
    assert.equal(getTask(matched.body.taskId!)?.branch, checkoutBranch)
    assert.ok(getEmitter(matched.body.taskId!))
    assert.equal(probes.length, 1)
  } finally {
    for (const probe of probes) probe.emit('close', 1)
    await new Promise(resolve => setImmediate(resolve))
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    childProcess.spawn = originalSpawn
    childProcess.execFileSync = originalExecFile
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
