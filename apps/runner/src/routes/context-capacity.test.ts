import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('/agent-context reports runner-wide capacity, unaffected by ?repo=', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-context-capacity-'))
  const previousDataDir = process.env.DATA_DIR
  const previousMax = process.env.MAX_CONCURRENT_TASKS
  process.env.DATA_DIR = dataDir
  process.env.MAX_CONCURRENT_TASKS = '5'
  const { db } = await import('../db/schema.js')
  const { insertTask } = await import('../db/queries.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    // 2 active tasks (queued + running), plus a terminal one that must not count.
    insertTask({ id: 'q1', repo: 'alpha', branch: 'test', prompt: 'x', status: 'queued', log: '', createdAt: new Date().toISOString() })
    insertTask({ id: 'r1', repo: 'beta', branch: 'test', prompt: 'x', status: 'running', log: '', createdAt: new Date().toISOString() })
    insertTask({ id: 'c1', repo: 'alpha', branch: 'test', prompt: 'x', status: 'completed', log: '', createdAt: new Date().toISOString() })

    const { port } = server.address() as { port: number }
    const snapshot = await (await fetch(`http://127.0.0.1:${port}/agent-context`)).json()
    assert.deepEqual(snapshot.capacity, { activeTasks: 2, maxConcurrentTasks: 5, availableSlots: 3 })

    // ?repo= narrows the repo-scoped collections but MUST NOT narrow capacity
    // (concurrency is a global runner property).
    const filtered = await (await fetch(`http://127.0.0.1:${port}/agent-context?repo=alpha`)).json()
    assert.deepEqual(filtered.capacity, { activeTasks: 2, maxConcurrentTasks: 5, availableSlots: 3 })
    assert.equal(filtered.liveTasksCount, 1)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    if (previousMax === undefined) delete process.env.MAX_CONCURRENT_TASKS
    else process.env.MAX_CONCURRENT_TASKS = previousMax
    await rm(dataDir, { recursive: true, force: true })
  }
})
