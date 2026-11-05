import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('coordination since filters validate shape and SQLite parsing without losing boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-since-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('../db/schema.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const get = (endpoint: string, query = '') => fetch(`http://127.0.0.1:${port}/${endpoint}?${query}`)
    const day = new Date().toISOString().slice(0, 10)
    const insert = db.prepare('INSERT INTO agent_events (event_type, created_at) VALUES (?, ?)')
    insert.run('before', `${day} 11:59:59`)
    const exact = Number(insert.run('exact', `${day} 12:00:00`).lastInsertRowid)
    const fraction = Number(insert.run('fraction', `${day} 12:00:00.125`).lastInsertRowid)
    const historical = Number(insert.run('historical', '2000-01-01 00:00:00').lastInsertRowid)
    for (const endpoint of ['agent-events', 'agent-context']) {
      const rows = (body: any): { id: number }[] => endpoint === 'agent-events' ? body : body.recentEvents
      for (const query of ['since=', 'since=%20', 'since=garbage', 'since=2026-99-01',
        'since=2026-11-05T25:00:00Z', 'since=valid&since=invalid',
        'since=2026-11-05&since=2026-11-05', 'since[]=2026-11-05', 'since[x]=2026-11-05', 'since=2026-11-05&since[x]=x']) {
        const response = await get(endpoint, query)
        assert.equal(response.status, 400, `${endpoint}?${query}`)
        assert.match(response.headers.get('content-type')!, /application\/json/)
        assert.match((await response.json()).error, /since.*single.*timestamp/)
      }
      for (const [bound, expected] of [
        [`${day} 12:00:00`, [fraction, exact]],
        [`${day}T12:00:00Z`, [fraction, exact]],
        [`${day}T14:00:00+02:00`, [fraction, exact]],
        [`${day}T07:00:00-05:00`, [fraction, exact]],
        [`${day}T12:00:00.000Z`, [fraction, exact]],
        [`${day} 12:00:00.125`, [fraction]],
        [`${day}T14:00:00.125+02:00`, [fraction]],
        ['9999-01-01T00:00:00Z', []],
      ] as const) {
        const response = await get(endpoint, `since=${encodeURIComponent(bound)}`)
        assert.equal(response.status, 200, bound)
        const body = await response.json()
        assert.deepEqual(rows(body).map(row => row.id), expected, bound)
        if (endpoint === 'agent-context') assert.equal(body.since, bound)
      }
      const response = await get(endpoint)
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(rows(body).some(row => row.id === historical), endpoint === 'agent-events')
      if (endpoint === 'agent-context') assert.ok(Date.now() - Date.parse(body.since + 'Z') >= 23 * 60 * 60 * 1000)
    }
    for (const since of ['since=', 'since=invalid', `since=${day}`, 'since[]=value']) {
      const response = await get('agent-events', `afterId=0&${since}`)
      assert.equal(response.status, 400)
      assert.match((await response.json()).error, /since and afterId cannot be used together/)
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(directory, { recursive: true, force: true })
  }
})
