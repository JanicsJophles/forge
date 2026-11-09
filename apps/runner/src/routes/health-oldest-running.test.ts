import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('GET /health reports the oldest running task age in seconds', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-health-oldest-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = dataDir
  const { db } = await import('../db/schema.js')
  const { insertTask } = await import('../db/queries.js')
  const { healthRouter } = await import('./health.js')
  const server = express().use(healthRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const getHealth = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      assert.equal(response.status, 200)
      return response.json()
    }

    // No tasks at all → null.
    let body = await getHealth()
    assert.equal(body.oldestRunningTaskAgeSeconds, null)

    // A queued-only task has no started_at → still null.
    insertTask({
      id: 'queued', repo: 'forge', branch: 'test', prompt: 'fixture',
      status: 'queued', log: '', createdAt: new Date().toISOString(),
    })
    body = await getHealth()
    assert.equal(body.oldestRunningTaskAgeSeconds, null)

    // A running task started 120s ago → a positive integer at least that age.
    insertTask({
      id: 'old-running', repo: 'forge', branch: 'test', prompt: 'fixture',
      status: 'running', log: '', createdAt: new Date().toISOString(),
    })
    db.prepare(
      `UPDATE tasks SET started_at = datetime('now', '-120 seconds') WHERE id = 'old-running'`
    ).run()
    // A newer running task must not shadow the older one (MIN start wins).
    insertTask({
      id: 'new-running', repo: 'forge', branch: 'test', prompt: 'fixture',
      status: 'running', log: '', createdAt: new Date().toISOString(),
    })
    db.prepare(
      `UPDATE tasks SET started_at = datetime('now', '-5 seconds') WHERE id = 'new-running'`
    ).run()
    body = await getHealth()
    assert.ok(Number.isInteger(body.oldestRunningTaskAgeSeconds))
    assert.ok(body.oldestRunningTaskAgeSeconds >= 120)
    assert.ok(body.oldestRunningTaskAgeSeconds < 600)

    // Existing fields remain intact alongside the new one.
    for (const field of [
      'status', 'activeTasks', 'queuedOrRunning', 'maxConcurrentTasks',
      'freeDiskMb', 'diskOk', 'uptimeSeconds',
    ]) {
      assert.ok(Object.hasOwn(body, field), `missing field ${field}`)
    }

    // The build version is reported so a single health poll identifies the
    // live build, matching what /capabilities returns.
    const { version } = await import('../version.js')
    assert.equal(body.version, version)
    assert.equal(typeof body.version, 'string')
    assert.ok(body.version.length > 0)

    // The data-volume free disk is reported alongside the repo-volume figure so
    // /health cannot look healthy while admission rejects tasks for low
    // data-volume space. The real temp DATA_DIR stats cleanly → a number here.
    assert.ok(Object.hasOwn(body, 'dataFreeDiskMb'), 'missing field dataFreeDiskMb')
    assert.ok(Object.hasOwn(body, 'dataDiskOk'), 'missing field dataDiskOk')
    assert.equal(typeof body.dataFreeDiskMb, 'number')
    assert.ok(body.dataFreeDiskMb >= 0)
    assert.equal(typeof body.dataDiskOk, 'boolean')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})
