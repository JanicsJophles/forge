import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import express from 'express'

test('GET /metrics serves runner stats in Prometheus text format', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-metrics-'))
  const previous = {
    DATA_DIR: process.env.DATA_DIR,
    ALLOWED_REPO_PATHS: process.env.ALLOWED_REPO_PATHS,
    DOTENV_CONFIG_PATH: process.env.DOTENV_CONFIG_PATH,
  }
  process.env.DATA_DIR = dataDir
  // A real directory so freeDiskBytes resolves and forge_free_disk_mb is present.
  process.env.ALLOWED_REPO_PATHS = dataDir
  process.env.DOTENV_CONFIG_PATH = '/dev/null'

  const { db } = await import('../db/schema.js')
  const { insertTask } = await import('../db/queries.js')
  const { metricsRouter } = await import('./metrics.js')
  const server = express().use(metricsRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const getMetrics = async () => {
      const response = await fetch(`${base}/metrics`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'text/plain; version=0.0.4')
      return response.text()
    }

    // With no running task, the oldest-running gauge is omitted; the
    // always-present gauges still answer.
    let body = await getMetrics()
    assert.ok(
      !body.includes('forge_oldest_running_task_age_seconds'),
      'oldest-running gauge should be omitted when nothing is running'
    )
    for (const name of [
      'forge_active_tasks',
      'forge_queued_or_running',
      'forge_max_concurrent_tasks',
      'forge_free_disk_mb',
      'forge_uptime_seconds',
    ]) {
      assert.ok(body.includes(`# HELP ${name} `), `missing HELP for ${name}`)
      assert.ok(body.includes(`# TYPE ${name} gauge`), `missing TYPE for ${name}`)
      assert.match(body, new RegExp(`^${name} \\d+$`, 'm'), `missing value line for ${name}`)
    }

    // A running task makes forge_oldest_running_task_age_seconds appear.
    insertTask({
      id: 'running', repo: 'forge', branch: 'test', prompt: 'fixture',
      status: 'running', log: '', createdAt: new Date().toISOString(),
    })
    db.prepare(
      `UPDATE tasks SET started_at = datetime('now', '-30 seconds') WHERE id = 'running'`
    ).run()

    body = await getMetrics()
    for (const name of [
      'forge_active_tasks',
      'forge_queued_or_running',
      'forge_max_concurrent_tasks',
      'forge_free_disk_mb',
      'forge_uptime_seconds',
      'forge_oldest_running_task_age_seconds',
    ]) {
      assert.ok(body.includes(`# HELP ${name} `), `missing HELP for ${name}`)
      assert.ok(body.includes(`# TYPE ${name} gauge`), `missing TYPE for ${name}`)
      assert.match(body, new RegExp(`^${name} \\d+$`, 'm'), `missing value line for ${name}`)
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
    db.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dataDir, { recursive: true, force: true })
  }
})
