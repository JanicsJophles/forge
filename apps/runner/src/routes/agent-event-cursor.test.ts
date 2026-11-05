import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('/agent-events catches up by exclusive ID without losing same-second events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-event-cursor-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('../db/schema.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(express.json()).use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const get = (query: string) => fetch(`http://127.0.0.1:${port}/agent-events?${query}`)
    const insert = db.prepare(`INSERT INTO agent_events (event_type, repo, ticket, created_at)
      VALUES (?, ?, ?, ?)`)
    const ids: number[] = []
    for (let index = 0; index < 23; index++) {
      // Interleave every kind of nonmatch to prove filtering precedes LIMIT.
      insert.run('transition', 'brain', 'FORGE-1', '2026-11-05 12:00:00')
      insert.run('transition', 'forge', 'OTHER', '2026-11-05 12:00:00')
      insert.run('noise', 'forge', 'FORGE-1', '2026-11-05 12:00:00')
      ids.push(Number(insert.run('transition', 'forge', 'FORGE-1', '2026-11-05 12:00:00').lastInsertRowid))
    }
    const filters = 'repo=forge&ticket=FORGE-1&type=transition&limit=7'
    const caught: number[] = []
    let cursor = 0
    let pages = 0
    for (;;) {
      const response = await get(`${filters}&afterId=${cursor}`)
      assert.equal(response.status, 200)
      const rows = await response.json() as { id: number }[]
      if (!rows.length) break
      assert.deepEqual(rows.map(row => row.id), ids.slice(caught.length, caught.length + 7))
      caught.push(...rows.map(row => row.id))
      cursor = rows.at(-1)!.id
      assert.ok(++pages <= 4, 'pagination must terminate')
    }
    assert.equal(pages, 4)
    assert.deepEqual(caught, ids)
    assert.equal(new Set(caught).size, ids.length)
    // A later insertion with an older timestamp is still an unseen ID.
    const lateId = Number(insert.run('transition', 'forge', 'FORGE-1', '2026-11-04 12:00:00').lastInsertRowid)
    assert.deepEqual((await (await get(`${filters}&afterId=${cursor}`)).json()).map((row: { id: number }) => row.id), [lateId])
    for (const query of [filters, `${filters}&since=2026-11-05T12:00:00Z`]) {
      assert.deepEqual((await (await get(query)).json()).map((row: { id: number }) => row.id), ids.slice().reverse().slice(0, 7))
    }
    assert.deepEqual(await (await get('afterId=9007199254740991')).json(), [])
    for (const value of ['', '-1', '1.5', '1e2', '0x10', '%201', '1%20', '%2B1', 'NaN', 'Infinity', '9007199254740992', '999999999999999999999999']) {
      const response = await get(`afterId=${value}`)
      assert.equal(response.status, 400, value)
      assert.match((await response.json()).error, /afterId/)
    }
    for (const query of ['afterId=0&afterId=1', 'afterId[]=0', 'afterId[x]=0']) {
      const response = await get(query)
      assert.equal(response.status, 400, query)
      assert.match((await response.json()).error, /afterId/)
    }
    for (const since of ['since=', 'since=invalid', 'since[]=value']) {
      const response = await get(`afterId=0&${since}`)
      assert.equal(response.status, 400)
      assert.match((await response.json()).error, /since and afterId/)
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(directory, { recursive: true, force: true })
  }
})
