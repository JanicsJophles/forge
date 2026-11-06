import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import express from 'express'

test('DELETE projects status without selecting stored transcripts for any task state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-cancel-projection-'))
  process.env.DATA_DIR = dir
  const { tasksRouter } = await import('./tasks.js')
  const { runTask, countActiveProcs } = await import('../agent/runner.js')
  const { insertTask, getTask, countActiveTasks } = await import('../db/queries.js')
  const { createEmitter, getEmitter } = await import('../agent/stream.js')
  const { db } = await import('../db/schema.js')
  const app = express().use('/tasks', tasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as import('node:net').AddressInfo
  const url = `http://127.0.0.1:${address.port}/tasks/`
  const originalPrepare = db.prepare
  const selects: string[] = []
  let inspect = false
  let cancellationWrites = 0
  let inspectQueuedWrites = false
  db.prepare = function (sql: string) {
    if (inspect && /^\s*SELECT\b/i.test(sql)) {
      selects.push(sql)
      // Guard against SELECT * and loading stored transcripts; arithmetic '*'
      // (e.g. durationMs scaling) is fine, so only a select-list star is barred.
      assert.doesNotMatch(sql, /SELECT\s+\*|\blog\b|\blog_tail\b|\bprompt\b/i)
    }
    if (inspectQueuedWrites && /^\s*UPDATE tasks/i.test(sql)) {
      assert.equal(db.inTransaction, true)
      cancellationWrites++
    }
    return originalPrepare.call(this, sql)
  } as typeof db.prepare
  const task = { repo: dir, branch: 'test', prompt: 'test', provider: 'claude' as const,
    status: 'queued' as const, log: 'noisy transcript\n'.repeat(512 * 1024), createdAt: new Date().toISOString() }
  const child = new EventEmitter() as any
  const signals: string[] = []
  Object.assign(child, {
    stdin: Object.assign(new EventEmitter(), { end() {} }),
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill(signal: string) { signals.push(signal); return true },
  })
  async function cancel(id: string, status: number, body: object) {
    selects.length = 0
    inspect = true
    let response: Response
    try {
      response = await fetch(url + id, { method: 'DELETE' })
    } finally {
      inspect = false
    }
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), body)
    assert.equal(selects.length, 1)
    assert.match(selects[0], /SELECT id, status/)
  }
  try {
    for (const status of ['queued', 'completed', 'failed'] as const) {
      insertTask({ ...task, id: status, status })
    }
    insertTask({ ...task, id: 'running' })
    const emitter = createEmitter('running')
    await runTask({ ...task, id: 'running' }, emitter, {
      spawn: (() => child) as any, executionIdentity: (() => ({})) as any,
      gitPull() {}, gitCommit: () => { throw new Error('must not commit') }, setTimeout, clearTimeout,
    })
    await cancel('running', 200, { ok: true })
    assert.deepEqual(signals, ['SIGTERM'])
    assert.equal(countActiveProcs(), 1)
    assert.equal(getTask('running')?.status, 'running')
    assert.equal(getEmitter('running'), emitter)
    inspectQueuedWrites = true
    await cancel('queued', 200, { ok: true })
    inspectQueuedWrites = false
    assert.equal(cancellationWrites, 2)
    const queued = getTask('queued')!
    assert.equal(queued.status, 'failed')
    assert.equal(queued.errorMessage, 'Task cancelled before launch')
    assert.ok(queued.completedAt)
    assert.equal(queued.log, task.log)
    assert.equal(countActiveTasks(), 1)
    for (const id of ['queued', 'completed', 'failed']) {
      await cancel(id, 409, { error: 'task is not active' })
    }
    await cancel('missing', 404, { error: 'task not found' })
    assert.deepEqual(signals, ['SIGTERM'])
    child.emit('close', 0, null)
    assert.equal(countActiveProcs(), 0)
    assert.equal(countActiveTasks(), 0)
    assert.equal(getEmitter('running'), undefined)
    assert.match(getTask('running')!.errorMessage!, /cancelled/)
  } finally {
    inspect = false
    child.emit('close', 0, null)
    db.prepare = originalPrepare
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
