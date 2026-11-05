import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import express from 'express'

test('DELETE saves queued cancellation reason and leaves terminal cleanup to runTask', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-queued-cancel-'))
  process.env.DATA_DIR = dir
  process.env.ALLOWED_REPO_PATHS = dir
  process.env.CODEX_RUN_USER = 'fake'
  const originalSpawn = childProcess.spawn
  const originalExecFile = childProcess.execFileSync
  const probe = new EventEmitter()
  Object.assign(probe, { kill: () => true })
  let launches = 0
  childProcess.execFileSync = (() => 'fake:x:1234:1234::/tmp:/bin/sh') as typeof childProcess.execFileSync
  childProcess.spawn = ((_command, args) => {
    assert.deepEqual(args, ['login', 'status'])
    launches++
    return probe
  }) as typeof childProcess.spawn
  syncBuiltinESMExports()
  const { tasksRouter } = await import('./tasks.js')
  const { runTask, countActiveProcs } = await import('../agent/runner.js')
  const { insertTask, getTask, countActiveTasks } = await import('../db/queries.js')
  const { createEmitter, getEmitter } = await import('../agent/stream.js')
  const { db } = await import('../db/schema.js')
  const app = express().use('/tasks', tasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as import('node:net').AddressInfo
  const url = `http://127.0.0.1:${address.port}/tasks/cancel`
  const task = { id: 'cancel', repo: dir, branch: 'test', prompt: 'test',
    provider: 'codex' as const, status: 'queued' as const, log: 'queued\n', createdAt: new Date().toISOString() }
  insertTask(task)
  const emitter = createEmitter(task.id)
  const events: { type: string; data: string }[] = []
  let done = 0
  emitter.on('event', event => events.push(event))
  emitter.on('done', () => done++)
  const pending = runTask(task, emitter)
  try {
    assert.equal(launches, 1)
    assert.equal(countActiveProcs(), 0)
    assert.equal((await fetch(url, { method: 'DELETE' })).status, 200)
    const cancelled = getTask(task.id)!
    assert.equal(cancelled.status, 'failed')
    assert.equal(cancelled.errorMessage, 'Task cancelled before launch')
    assert.ok(cancelled.completedAt)
    for (const view of ['', '?view=status', '?view=detail']) {
      const response = await fetch(url + view)
      assert.equal(response.status, 200)
      assert.equal((await response.json() as typeof cancelled).errorMessage, cancelled.errorMessage)
    }
    assert.equal(done, 0)
    assert.equal(events.length, 0)
    assert.equal(getEmitter(task.id), emitter)
    probe.emit('close', 0)
    await pending
    assert.equal(launches, 1) // Only the login probe; no agent starts.
    assert.equal(getEmitter(task.id), undefined)
    assert.equal(done, 1)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'error')
    assert.equal(events[0].data, cancelled.errorMessage)
    assert.equal(getTask(task.id)?.errorMessage, cancelled.errorMessage)
    assert.equal(getTask(task.id)?.completedAt, cancelled.completedAt)
    assert.equal((await fetch(url, { method: 'DELETE' })).status, 409)

    // Running cancellation delegates to killTask and holds capacity until close.
    const running = { ...task, id: 'running', provider: 'claude' as const }
    insertTask(running)
    const runningEmitter = createEmitter(running.id)
    const child = new EventEmitter() as any
    Object.assign(child, { stdin: Object.assign(new EventEmitter(), { end() {} }), stdout: new EventEmitter(), stderr: new EventEmitter() })
    const signals: string[] = []
    child.kill = (signal: string) => { signals.push(signal); return true }
    await runTask(running, runningEmitter, {
      spawn: (() => child) as any, executionIdentity: (() => ({})) as any,
      gitPull() {}, gitCommit: () => { throw new Error('must not commit') }, setTimeout, clearTimeout,
    })
    const runningUrl = url.replace('/cancel', '/running')
    assert.equal((await fetch(runningUrl, { method: 'DELETE' })).status, 200)
    assert.deepEqual(signals, ['SIGTERM'])
    assert.equal(getTask(running.id)?.status, 'running')
    assert.equal(countActiveTasks(), 1)
    assert.equal(countActiveProcs(), 1)
    assert.equal(getEmitter(running.id), runningEmitter)
    child.emit('close', 0, null)
    assert.equal(countActiveTasks(), 0)
    assert.equal(countActiveProcs(), 0)
    assert.equal(getEmitter(running.id), undefined)
    assert.match(getTask(running.id)!.errorMessage!, /cancelled/)
  } finally {
    probe.emit('close', 0)
    await pending
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    childProcess.spawn = originalSpawn
    childProcess.execFileSync = originalExecFile
    syncBuiltinESMExports()
    rmSync(dir, { recursive: true, force: true })
  }
})
