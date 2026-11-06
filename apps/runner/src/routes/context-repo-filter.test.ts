import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('/agent-context?repo narrows all three collections and rejects a blank repo', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-context-repo-filter-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = dataDir
  const { db } = await import('../db/schema.js')
  const { checkpoint, insertEvent } = await import('../db/agent-state.js')
  const { insertTask } = await import('../db/queries.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    // Two repos with different multiplicities so cross-contamination is visible.
    checkpoint({ agentId: 'alpha-1', repo: 'alpha', ticket: 'RAC-1' })
    checkpoint({ agentId: 'alpha-2', repo: 'alpha', ticket: 'RAC-2' })
    checkpoint({ agentId: 'beta-1', repo: 'beta', ticket: 'RAC-9' })
    insertEvent({ eventType: 'pr_opened', repo: 'alpha', agentId: 'alpha-1' })
    insertEvent({ eventType: 'pr_opened', repo: 'beta', agentId: 'beta-1' })
    insertEvent({ eventType: 'pr_opened', repo: 'beta', agentId: 'beta-1' })
    insertTask({
      id: 'alpha-task', repo: 'alpha', branch: 'test', prompt: 'fixture',
      status: 'running', log: '', createdAt: new Date().toISOString(),
    })
    insertTask({
      id: 'beta-task-1', repo: 'beta', branch: 'test', prompt: 'fixture',
      status: 'queued', log: '', createdAt: new Date().toISOString(),
    })
    insertTask({
      id: 'beta-task-2', repo: 'beta', branch: 'test', prompt: 'fixture',
      status: 'running', log: '', createdAt: new Date().toISOString(),
    })
    const { port } = server.address() as { port: number }
    const get = (query = '') => fetch(`http://127.0.0.1:${port}/agent-context${query}`)

    // Full snapshot — baseline, unchanged by omitting repo.
    const full = await (await get()).json()
    assert.equal(full.liveAgentsCount, 3)
    assert.equal(full.recentEventsCount, 3)
    assert.equal(full.liveTasksCount, 3)
    assert.deepEqual(full.liveByRepo, { alpha: 2, beta: 1 })
    assert.deepEqual(full.liveTasksByRepo, { alpha: 1, beta: 2 })

    // Filtered to alpha narrows all three collections and their counts/summaries.
    const response = await get('?repo=alpha')
    assert.equal(response.status, 200)
    const snapshot = await response.json()
    assert.equal(snapshot.liveAgentsCount, 2)
    assert.equal(snapshot.liveAgents.length, 2)
    assert.ok(snapshot.liveAgents.every((a: { repo: string }) => a.repo === 'alpha'))
    assert.equal(snapshot.recentEventsCount, 1)
    assert.equal(snapshot.recentEvents.length, 1)
    assert.ok(snapshot.recentEvents.every((e: { repo: string }) => e.repo === 'alpha'))
    assert.equal(snapshot.liveTasksCount, 1)
    assert.equal(snapshot.liveTasks.length, 1)
    assert.ok(snapshot.liveTasks.every((t: { repo: string }) => t.repo === 'alpha'))
    assert.deepEqual(snapshot.liveByRepo, { alpha: 2 })
    assert.deepEqual(snapshot.liveTasksByRepo, { alpha: 1 })
    assert.deepEqual(Object.keys(snapshot.liveByTicket).sort(), ['RAC-1', 'RAC-2'])

    // Blank/whitespace repo is rejected with a JSON error, mirroring /tasks.
    for (const query of ['?repo=', '?repo=%20']) {
      const rejected = await get(query)
      assert.equal(rejected.status, 400, query)
      assert.match(rejected.headers.get('content-type')!, /application\/json/)
      assert.equal((await rejected.json()).error, 'repo must be a non-empty string')
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})
