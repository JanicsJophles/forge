import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import express from 'express'

test('create and retry reject unavailable branch probes without dispatching', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-branch-unavailable-'))
  const repo = path.join(root, 'repo')
  const originalExec = childProcess.execFileSync
  const originalSpawn = childProcess.spawn
  const git = (...args: string[]) => originalExec('git', args, { cwd: repo, stdio: 'pipe' })
  originalExec('git', ['init', '-q', '-b', 'topic', repo])
  process.env.DATA_DIR = path.join(root, 'data')
  process.env.ALLOWED_REPO_PATHS = root
  process.env.MAX_CONCURRENT_TASKS = '10'
  process.env.MIN_FREE_DISK_MB = '0'
  process.env.CODEX_RUN_USER = 'fake'

  let failProbe = false
  let branchProbes = 0
  const launches: EventEmitter[] = []
  childProcess.execFileSync = ((file: string, args: string[], options: object) => {
    if (file !== 'git') return 'fake:x:1234:1234::/tmp:/bin/sh'
    if (args[0] === 'symbolic-ref') {
      branchProbes++
      if (failProbe) throw new Error('fatal: private stderr /secret/repository token=private')
    }
    return originalExec(file, args, options)
  }) as typeof childProcess.execFileSync
  childProcess.spawn = (() => {
    const proc = Object.assign(new EventEmitter(), { kill: () => true })
    launches.push(proc)
    return proc
  }) as typeof childProcess.spawn
  syncBuiltinESMExports()

  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  const { getTask, insertTask, updateTaskStatus } = await import('../db/queries.js')
  const { config } = await import('../config.js')
  const server = express().use(express.json()).use('/tasks', tasksRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as import('node:net').AddressInfo
  const count = () => (db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n
  let sequence = 0
  async function attempt(mode: 'create' | 'retry', claim: string | undefined, status: number, branch?: string) {
    const id = `source-${sequence++}`
    if (mode === 'retry') {
      insertTask({ id, repo, branch: claim ?? 'old-branch', prompt: 'test', provider: 'codex',
        status: 'failed', log: '', createdAt: new Date().toISOString() })
    }
    const before = count()
    const spawned = launches.length
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks${mode === 'retry' ? `/${id}/retry` : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, prompt: 'test', provider: 'codex', branch: claim }),
    })
    const body = await response.json() as { taskId?: string; error?: string }
    assert.equal(response.status, status, `${mode} claim=${claim}`)
    if (status === 201) {
      assert.ok(body.taskId)
      assert.equal(getTask(body.taskId)?.branch, branch)
      assert.equal(count(), before + 1)
      assert.equal(launches.length, spawned + 1)
      launches.at(-1)!.emit('close', 1)
      await new Promise(resolve => setImmediate(resolve))
    } else {
      assert.equal(body.taskId, undefined)
      assert.equal(count(), before)
      assert.equal(launches.length, spawned)
      if (status === 400) assert.deepEqual(body, { error: 'could not determine repository checkout branch' })
      if (status === 409) assert.equal(body.error, 'requested branch does not match the repository checkout')
    }
  }

  try {
    failProbe = true
    for (const mode of ['create', 'retry'] as const) {
      for (const claim of ['topic', 'different', undefined]) await attempt(mode, claim, 400)
    }
    // Earlier admission guards still win and never attempt branch discovery.
    insertTask({ id: 'active', repo, branch: 'topic', prompt: 'busy', status: 'queued', log: '', createdAt: new Date().toISOString() })
    const beforeProbes = branchProbes
    const blocked = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, prompt: 'test', branch: 'topic' }),
    })
    assert.equal(blocked.status, 409)
    assert.equal(branchProbes, beforeProbes)
    updateTaskStatus('active', 'failed')
    const capacity = config.maxConcurrentTasks
    config.maxConcurrentTasks = 0
    for (const mode of ['create', 'retry'] as const) await attempt(mode, 'topic', 429)
    config.maxConcurrentTasks = capacity
    assert.equal(branchProbes, beforeProbes)

    failProbe = false
    // Both unborn and committed symbolic checkouts resolve the branch identically.
    for (const committed of [false, true]) {
      if (committed) git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'init')
      for (const claim of ['topic', 'different', undefined]) {
        await attempt('create', claim, claim === 'different' ? 409 : 201, 'topic')
        // Retry ignores old/body claims and resolves the current checkout.
        await attempt('retry', claim, 201, 'topic')
      }
    }
    git('checkout', '--detach', '-q')
    for (const claim of ['HEAD', 'topic', undefined]) {
      await attempt('create', claim, claim === 'topic' ? 409 : 201, 'HEAD')
      await attempt('retry', claim, 201, 'HEAD')
    }
  } finally {
    for (const proc of launches) proc.emit('close', 1)
    await new Promise(resolve => setImmediate(resolve))
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    childProcess.execFileSync = originalExec
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
