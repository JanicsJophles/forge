import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import express from 'express'

// GET /health exposes `acceptingTasks`: a single go/no-go that mirrors
// admitCheckout (tasks.ts) — accepting only when BOTH disk volumes are known
// and healthy AND concurrency has room. We drive the three cases by controlling
// the free-disk reading (fs.statfsSync override, same approach as
// task-data-disk.test.ts) and the queued/running task count.
test('GET /health reports acceptingTasks matching admission', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-health-accepting-'))
  const repo = path.join(root, 'repo')
  const data = path.join(root, 'sqlite-volume')
  fs.mkdirSync(repo)
  fs.mkdirSync(data)
  process.env.DOTENV_CONFIG_PATH = path.join(root, 'no-env-file')
  process.env.DATA_DIR = data
  process.env.ALLOWED_REPO_PATHS = repo
  process.env.MIN_FREE_DISK_MB = '100'
  process.env.MAX_CONCURRENT_TASKS = '2'

  const originalStatfs = fs.statfsSync
  let repoMb: number | null = 200
  let dataMb: number | null = 200
  fs.statfsSync = ((directory: string) => {
    assert.ok(directory === repo || directory === data, `unexpected path ${directory}`)
    const mb = directory === repo ? repoMb : dataMb
    if (mb === null) throw new Error('injected stat failure')
    return { bavail: mb, bsize: 1024 * 1024 }
  }) as typeof fs.statfsSync
  syncBuiltinESMExports()

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
    const addActiveTask = (id: string) =>
      insertTask({
        id, repo: 'forge', branch: 'test', prompt: 'fixture',
        status: 'running', log: '', createdAt: new Date().toISOString(),
      })

    // Healthy: both volumes above the floor, concurrency has room → accepting,
    // and this is only a readiness hint so status is still 'ok'.
    repoMb = 200
    dataMb = 200
    let body = await getHealth()
    assert.equal(body.status, 'ok')
    assert.equal(body.diskOk, true)
    assert.equal(body.dataDiskOk, true)
    assert.equal(body.queuedOrRunning, 0)
    assert.equal(body.acceptingTasks, true)
    // Accepting → the reason code is null (purely additive to acceptingTasks).
    assert.equal(body.notAcceptingReason, null)

    // At/over concurrency: fill the 2 slots. Disk is fine but there is no room,
    // so admission would refuse → acceptingTasks is false.
    addActiveTask('running-1')
    addActiveTask('running-2')
    body = await getHealth()
    assert.equal(body.status, 'ok')
    assert.equal(body.queuedOrRunning, 2)
    assert.equal(body.maxConcurrentTasks, 2)
    assert.equal(body.diskOk, true)
    assert.equal(body.dataDiskOk, true)
    assert.equal(body.acceptingTasks, false)
    // Both disks healthy, only slots are full → 'concurrency'.
    assert.equal(body.notAcceptingReason, 'concurrency')
    db.prepare('DELETE FROM tasks').run()

    // Low disk: a reading below MIN_FREE_DISK_MB → acceptingTasks false even
    // though concurrency has room.
    repoMb = 99
    dataMb = 200
    body = await getHealth()
    assert.equal(body.status, 'ok')
    assert.equal(body.diskOk, false)
    assert.equal(body.queuedOrRunning, 0)
    assert.equal(body.acceptingTasks, false)
    // Repo volume is the one below the floor → 'disk'.
    assert.equal(body.notAcceptingReason, 'disk')

    // Low data disk: repo volume healthy but the sqlite volume is below the floor
    // → 'dataDisk', distinguishing the two volumes a dispatcher would otherwise
    // have to tell apart from diskOk/dataDiskOk itself.
    repoMb = 200
    dataMb = 99
    body = await getHealth()
    assert.equal(body.status, 'ok')
    assert.equal(body.diskOk, true)
    assert.equal(body.dataDiskOk, false)
    assert.equal(body.acceptingTasks, false)
    assert.equal(body.notAcceptingReason, 'dataDisk')

    // Unknown disk: a null (stat failure) reading is fail-safe — we do not claim
    // capacity we cannot verify, so acceptingTasks is false.
    repoMb = 200
    dataMb = null
    body = await getHealth()
    assert.equal(body.status, 'ok')
    assert.equal(body.dataDiskOk, null)
    assert.equal(body.acceptingTasks, false)
    // A null/unverifiable reading reports 'unknown' — never silently healthy.
    assert.equal(body.notAcceptingReason, 'unknown')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    fs.statfsSync = originalStatfs
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
