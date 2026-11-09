import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('/agent-context capacity clamps availableSlots at zero when over budget', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-context-capacity-clamp-'))
  const previousDataDir = process.env.DATA_DIR
  const previousMax = process.env.MAX_CONCURRENT_TASKS
  process.env.DATA_DIR = dataDir
  process.env.MAX_CONCURRENT_TASKS = '1'
  const { db } = await import('../db/schema.js')
  const { insertTask } = await import('../db/queries.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    // 3 active tasks against a budget of 1 → availableSlots must be 0, never negative.
    for (let n = 0; n < 3; n++) {
      insertTask({ id: `r${n}`, repo: 'alpha', branch: 'test', prompt: 'x', status: 'running', log: '', createdAt: new Date().toISOString() })
    }
    const { port } = server.address() as { port: number }
    const snapshot = await (await fetch(`http://127.0.0.1:${port}/agent-context`)).json()
    assert.deepEqual(snapshot.capacity, { activeTasks: 3, maxConcurrentTasks: 1, availableSlots: 0 })
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
