import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('GET /health reports the deadline + disk thresholds from config', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-health-thresholds-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = dataDir
  const { db } = await import('../db/schema.js')
  const { healthRouter } = await import('./health.js')
  const { config } = await import('../config.js')
  const server = express().use(healthRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(response.status, 200)
    const body = await response.json()

    // The two new fields mirror config exactly so a monitor can compute how
    // close oldestRunningTaskAgeSeconds is to the SIGTERM deadline, and how much
    // disk headroom remains above the admission floor, without a second call.
    assert.equal(body.taskTimeoutMs, config.taskTimeoutMs)
    assert.equal(body.minFreeDiskMb, config.minFreeDiskMb)
    assert.equal(typeof body.taskTimeoutMs, 'number')
    assert.equal(typeof body.minFreeDiskMb, 'number')

    // Every existing field is still present and unchanged.
    for (const field of [
      'status', 'version', 'activeTasks', 'queuedOrRunning',
      'maxConcurrentTasks', 'freeDiskMb', 'diskOk', 'dataFreeDiskMb',
      'dataDiskOk', 'acceptingTasks', 'notAcceptingReason', 'uptimeSeconds',
      'oldestRunningTaskAgeSeconds',
    ]) {
      assert.ok(Object.hasOwn(body, field), `missing field ${field}`)
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})
