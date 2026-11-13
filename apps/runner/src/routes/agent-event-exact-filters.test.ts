import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('exact event filters reject malformed queries and preserve identities before pagination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-event-exact-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('../db/schema.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const get = (query: string) => fetch(`http://127.0.0.1:${port}/agent-events?${query}`)
    const insert = db.prepare(`INSERT INTO agent_events (repo, ticket, event_type, agent_id, created_at)
      VALUES (?, ?, ?, ?, ?)`)
    const stamp = '2026-11-05 12:00:00'
    const identity = { repo: ' forge ', ticket: ' F-1 ', type: ' transition ' }
    const add = (values = identity, agent = 'worker', time = stamp) =>
      Number(insert.run(values.repo, values.ticket, values.type, agent, time).lastInsertRowid)
    const ids: number[] = []
    for (let index = 0; index < 5; index++) {
      ids.push(add())
      for (const field of ['repo', 'ticket', 'type'] as const) {
        add({ ...identity, [field]: identity[field].trim() })
      }
      add(identity, 'other')
    }
    const olderId = add(identity, 'worker', '2026-11-04 12:00:00')

    // Every malformed shape must return only a static error, never the global event window.
    for (const field of ['repo', 'ticket', 'type']) {
      for (const invalid of [
        `${field}=`, `${field}=%20%09%0A`,
        `${field}=private-marker&${field}=private-marker`,
        `${field}=private-marker&${field}=other`,
        `${field}[]=private-marker`, `${field}[nested]=private-marker`,
        `${field}=private-marker&${field}[nested]=other`,
      ]) {
        const response = await get(invalid)
        assert.equal(response.status, 400, invalid)
        assert.match(response.headers.get('content-type')!, /application\/json/)
        assert.deepEqual(await response.json(), { error: `${field} must be a single nonempty string` })
      }
    }

    for (const field of ['repo', 'ticket', 'type'] as const) {
      const response = await get(new URLSearchParams({ [field]: identity[field], limit: '1000' }).toString())
      assert.equal(response.status, 200)
      const rows = await response.json() as Record<string, unknown>[]
      assert.ok(rows.length > 0)
      assert.ok(rows.every(row => row[field === 'type' ? 'eventType' : field] === identity[field]))
      const absent = await get(new URLSearchParams({ [field]: "x' OR 1=1 --" }).toString())
      assert.equal(absent.status, 200)
      assert.deepEqual(await absent.json(), [])
    }
    const filters = new URLSearchParams({ ...identity, agentId: 'worker', limit: '2' })
    filters.set('since', stamp)
    const recent = await get(filters.toString())
    assert.equal(recent.status, 200)
    assert.deepEqual((await recent.json()).map((row: { id: number }) => row.id), ids.slice(-2).reverse())

    filters.delete('since')
    // Start after the first matching event to exclude it, then drain in ascending ID order.
    let cursor = ids[0]
    const caught: number[] = []
    for (let page = 0; page < 4; page++) {
      filters.set('afterId', String(cursor))
      const response = await get(filters.toString())
      assert.equal(response.status, 200)
      const rows = await response.json() as { id: number }[]
      if (!rows.length) break
      caught.push(...rows.map(row => row.id))
      cursor = rows.at(-1)!.id
    }
    // afterId uses insertion order, including the older timestamp inserted last.
    assert.deepEqual(caught, [...ids.slice(1), olderId])

    const all = await get('limit=1000')
    assert.equal(all.status, 200)
    assert.equal((await all.json()).length, 26)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(directory, { recursive: true, force: true })
  }
})
