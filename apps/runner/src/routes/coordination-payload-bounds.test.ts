import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('coordination bounds reject before writes and preserve structured values and board reads', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-coordination-bounds-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = dataDir
  const { db } = await import('../db/schema.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(express.json({ limit: '2mb' })).use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const url = `http://127.0.0.1:${port}`
    const post = (route: string, body: Record<string, unknown>) => fetch(url + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const get = async (route: string) => {
      const response = await fetch(url + route)
      assert.equal(response.status, 200)
      return response.json()
    }
    const stored = () => ({
      states: db.prepare('SELECT * FROM agent_state').all(),
      events: db.prepare('SELECT * FROM agent_events').all(),
    })
    // JSON syntax and multibyte code points both count toward the exact byte limit.
    const structured = { v: '😀'.repeat(4094) }
    assert.equal(Buffer.byteLength(JSON.stringify(structured)), 16384)
    const agentId = 'é'.repeat(250)
    const checkpoint = { agentId, repo: 'forge', metadata: structured, intent: 'normal' }
    let response = await post('/agent-state/checkpoint', checkpoint)
    assert.equal(response.status, 200)
    const state = await response.json()
    assert.equal(state.agentId, agentId)
    assert.deepEqual(state.metadata, structured)
    response = await post('/agent-events', { eventType: 'é'.repeat(250), agentId, repo: 'forge', details: structured })
    assert.equal(response.status, 201)
    const event = await response.json()
    assert.deepEqual(event.details, structured)
    assert.equal(event.agentId, agentId)

    for (const [route, base, fields, error] of [
      ['/agent-state/checkpoint', checkpoint, ['agentId', 'agentType', 'repo', 'branch', 'intent', 'ticket', 'status'], 'checkpoint payload exceeds field size limits'],
      ['/agent-events', { eventType: 'normal', agentId }, ['agentId', 'eventType', 'repo', 'ticket'], 'event payload exceeds field size limits'],
    ] as const) {
      const structuredField = route === '/agent-events' ? 'details' : 'metadata'
      const invalid = [
        ...fields.flatMap(field => [
          { ...base, [field]: 'x'.repeat(501) },
          { ...base, [field]: 'é'.repeat(251) },
        ]),
        { ...base, [structuredField]: { v: structured.v + 'x' } },
        { ...base, [structuredField]: { v: '\\'.repeat(8190) } },
      ]
      for (const body of invalid) {
        const before = stored()
        response = await post(route, body)
        assert.equal(response.status, 400)
        assert.match(response.headers.get('content-type') ?? '', /application\/json/)
        assert.deepEqual(await response.json(), { error })
        assert.deepEqual(stored(), before)
      }
    }
    assert.deepEqual(await get('/agent-state?repo=forge'), [state])
    assert.deepEqual(await get('/agent-events?repo=forge'), [event])
    const board = await get('/agent-context?repo=forge')
    assert.deepEqual(board.liveAgents, [state])
    assert.deepEqual(board.recentEvents, [event])
    assert.equal(board.liveAgentsCount, 1)
    assert.equal(board.recentEventsCount, 1)
    assert.equal(board.recentEventsTruncated, false)

    for (const patch of [{}, { metadata: null }, { metadata: { nested: [true, { text: 'é' }] } }]) {
      response = await post('/agent-state/checkpoint', { agentId, ...patch })
      assert.equal(response.status, 200)
      assert.deepEqual((await response.json()).metadata, 'metadata' in patch ? patch.metadata : structured)
    }
    response = await post('/agent-events', { eventType: 'normal', details: { nested: [1, null] }, prNumber: 42 })
    assert.equal(response.status, 201)
    assert.deepEqual((await response.json()).details, { nested: [1, null] })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})
