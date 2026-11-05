import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('/agent-context serializes exact counts for arbitrary repo and ticket names', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-context-counts-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = dataDir
  const { db } = await import('../db/schema.js')
  const { checkpoint } = await import('../db/agent-state.js')
  const { insertTask } = await import('../db/queries.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const names = ['constructor', 'toString', '__proto__', 'owner/forge']
    for (const [index, name] of names.entries()) {
      // Different multiplicities make dropped or cross-assigned counts visible.
      for (let n = 0; n < index + 2; n++) {
        checkpoint({ agentId: `${index}-${n}`, repo: name, ticket: name })
      }
      for (let n = 0; n < index + 3; n++) {
        insertTask({
          id: `${index}-${n}`, repo: name, branch: 'test', prompt: 'fixture',
          status: n % 2 ? 'running' : 'queued', log: '', createdAt: new Date().toISOString(),
        })
      }
      insertTask({
        id: `completed-${index}`, repo: name, branch: 'test', prompt: 'fixture',
        status: 'completed', log: '', createdAt: new Date().toISOString(),
      })
    }
    checkpoint({ agentId: 'without-names' })
    checkpoint({ agentId: 'empty-names', repo: '', ticket: '' })
    const { port } = server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${port}/agent-context`)
    assert.equal(response.status, 200)
    const snapshot = await response.json()
    for (const field of ['liveByRepo', 'liveByTicket', 'liveTasksByRepo']) {
      const counts = snapshot[field]
      assert.deepEqual(Object.keys(counts).sort(), [...names].sort())
      for (const [index, name] of names.entries()) {
        assert.equal(Object.hasOwn(counts, name), true)
        assert.equal(counts[name], index + (field === 'liveTasksByRepo' ? 3 : 2))
        assert.ok(Number.isInteger(counts[name]) && counts[name] > 0)
      }
    }
    assert.equal(snapshot.liveAgentsCount, 16)
    assert.equal(snapshot.liveTasksCount, 18)
    assert.equal(snapshot.liveAgents.length, 16)
    assert.equal(snapshot.liveTasks.length, 18)
    assert.deepEqual(snapshot.recentEvents, [])
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})
