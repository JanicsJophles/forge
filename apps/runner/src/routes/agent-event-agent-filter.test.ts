import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('event history filters exact identities before limiting and paging', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-event-agent-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('../db/schema.js')
  const { listEvents } = await import('../db/agent-state.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const get = (query: string) => fetch(`http://127.0.0.1:${port}/agent-events?${query}`)
    const stamp = '2026-11-05 12:00:00'
    const insert = db.prepare(`INSERT INTO agent_events (agent_id, repo, event_type, ticket, created_at)
      VALUES (?, ?, ?, ?, ?)`)
    const ids: number[] = []
    for (let index = 0; index < 23; index++) {
      ids.push(Number(insert.run('worker', 'forge', 'transition', 'F-1', stamp).lastInsertRowid))
      for (const agent of ['worker-2', 'Worker', null]) insert.run(agent, 'forge', 'transition', 'F-1', stamp)
      insert.run('worker', 'brain', 'transition', 'F-1', stamp)
      insert.run('worker', 'forge', 'noise', 'F-1', stamp)
      insert.run('worker', 'forge', 'transition', 'other', stamp)
    }
    const filters = { agentId: 'worker', repo: 'forge', eventType: 'transition', ticket: 'F-1', limit: 7 }
    const query = 'agentId=worker&repo=forge&type=transition&ticket=F-1&limit=7'
    assert.deepEqual(listEvents(filters).map(row => row.id), ids.slice().reverse().slice(0, 7))
    for (const suffix of ['', `&since=${encodeURIComponent(stamp)}`]) {
      const response = await get(query + suffix)
      assert.equal(response.status, 200)
      assert.deepEqual((await response.json()).map((row: { id: number }) => row.id), ids.slice().reverse().slice(0, 7))
    }
    const caught: number[] = []
    let cursor = 0
    for (let page = 0; page < 5; page++) {
      const response = await get(`${query}&afterId=${cursor}`)
      assert.equal(response.status, 200)
      const rows = await response.json() as { id: number }[]
      assert.deepEqual(rows.map(row => row.id), listEvents({ ...filters, afterId: cursor }).map(row => row.id))
      if (!rows.length) break
      caught.push(...rows.map(row => row.id))
      cursor = rows.at(-1)!.id
    }
    assert.deepEqual(caught, ids)
    assert.deepEqual(listEvents({ ...filters, afterId: cursor }), [])
    for (const identity of ["x' OR 1=1 --", ' worker ', '%', 'missing']) {
      const expected = identity === 'missing' ? [] : [
        Number(insert.run(identity, 'forge', 'transition', 'F-1', stamp).lastInsertRowid),
      ]
      assert.deepEqual(listEvents({ agentId: identity }).map(row => row.id), expected)
      const response = await get(`agentId=${encodeURIComponent(identity)}`)
      assert.equal(response.status, 200)
      assert.deepEqual((await response.json()).map((row: { id: number }) => row.id), expected)
    }
    const unfiltered = await get('limit=1000')
    assert.equal(unfiltered.status, 200)
    assert.deepEqual((await unfiltered.json()).map((row: { id: number }) => row.id),
      listEvents({ limit: 1000 }).map(row => row.id))
    for (const invalid of ['agentId=', 'agentId=%20', 'agentId=worker&agentId=worker',
      'agentId=worker&agentId=other', 'agentId[]=worker', 'agentId[x]=worker',
      'agentId=worker&agentId[x]=other']) {
      const response = await get(invalid)
      assert.equal(response.status, 400, invalid)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      assert.match((await response.json()).error, /agentId/)
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(directory, { recursive: true, force: true })
  }
})
