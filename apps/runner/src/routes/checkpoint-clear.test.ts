import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('checkpoint patches retain omitted fields, clear nulls and replace supplied values', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-checkpoint-clear-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = dataDir
  const { db } = await import('../db/schema.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(express.json()).use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const url = `http://127.0.0.1:${port}`
    const post = async (patch: Record<string, unknown>, agentId = 'worker') => {
      const response = await fetch(`${url}/agent-state/checkpoint`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, ...patch }),
      })
      assert.equal(response.status, 200)
      return response.json()
    }
    const context = async () => {
      const response = await fetch(`${url}/agent-context`)
      assert.equal(response.status, 200)
      return response.json()
    }
    let now = Date.now()
    t.mock.method(Date, 'now', () => now)
    const fields = {
      repo: 'owner/old', branch: 'old-branch', ticket: 'OLD-1', intent: 'old intent',
      filesTouched: ['old.ts'], metadata: { old: true }, status: 'editing',
    }
    const created = await post({ ...fields, agentType: 'forge', ttlSeconds: 60 })
    let snapshot = await context()
    assert.deepEqual(snapshot.liveByRepo, { 'owner/old': 1 })
    assert.deepEqual(snapshot.liveByTicket, { 'OLD-1': 1 })

    now += 2000
    const retained = await post({})
    for (const [field, value] of Object.entries(fields)) assert.deepEqual(retained[field], value)
    assert.equal(retained.agentType, 'forge')
    assert.equal(retained.createdAt, created.createdAt)
    assert.equal(Date.parse(retained.expiresAt + 'Z'), now - now % 1000 + 3600000)
    assert.ok(retained.expiresAt > created.expiresAt)

    const replacements = {
      repo: 'owner/new', branch: 'new-branch', ticket: 'NEW-2', intent: '',
      filesTouched: [], metadata: {}, status: 'testing',
    }
    const replaced = await post(replacements)
    for (const [field, value] of Object.entries(replacements)) assert.deepEqual(replaced[field], value)

    const cleared = await post(Object.fromEntries(Object.keys(fields).map(field => [field, null])))
    for (const field of Object.keys(fields)) assert.equal(cleared[field], null, field)
    assert.equal(cleared.agentType, 'forge')
    snapshot = await context()
    assert.deepEqual(snapshot.liveByRepo, {})
    assert.deepEqual(snapshot.liveByTicket, {})
    assert.equal(snapshot.liveAgentsCount, 1)
    assert.equal(snapshot.liveAgents[0].repo, null)
    assert.equal(snapshot.liveAgents[0].ticket, null)
    const afterClear = await post({})
    for (const field of Object.keys(fields)) assert.equal(afterClear[field], null)

    const defaults = await post({ repo: null, filesTouched: null, metadata: null }, 'new-worker')
    assert.equal(defaults.agentType, 'unknown')
    for (const field of Object.keys(fields)) assert.equal(defaults[field], null)
    const restored = await post({ ...fields, agentType: 'local' })
    for (const [field, value] of Object.entries(fields)) assert.deepEqual(restored[field], value)
    assert.equal(restored.agentType, 'local')
    const byRepo = await fetch(`${url}/agent-state?repo=owner%2Fold`)
    assert.equal((await byRepo.json()).length, 1)
    await post({ repo: null, ticket: null })
    for (const filter of ['repo=owner%2Fold', 'ticket=OLD-1']) {
      const response = await fetch(`${url}/agent-state?${filter}`)
      assert.deepEqual(await response.json(), [])
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})
