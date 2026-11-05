import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('/agent-events validates limits and filters before applying the default or cap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-event-limit-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('../db/schema.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const get = (query: string) => fetch(`http://127.0.0.1:${port}/agent-events?${query}`)
    const insert = db.prepare(`INSERT INTO agent_events (event_type, repo, ticket, created_at)
      VALUES (?, ?, ?, ?)`)
    const ids: number[] = []
    const cursorIds: number[] = []
    db.transaction(() => {
      for (let index = 0; index < 1005; index++) {
        insert.run('transition', 'other', 'TASK', '2026-11-05 12:00:00')
        insert.run('transition', 'forge', 'OTHER', '2026-11-05 12:00:00')
        insert.run('noise', 'forge', 'TASK', '2026-11-05 12:00:00')
        cursorIds.push(Number(insert.run('transition', 'forge', 'TASK', '2026-11-04 12:00:00').lastInsertRowid))
        ids.push(Number(insert.run('transition', 'forge', 'TASK', '2026-11-05 12:00:00').lastInsertRowid))
        cursorIds.push(ids.at(-1)!)
      }
    })()
    // This case runs on the base; the optional cursor case also runs when
    // composed with PR #56, without duplicating that PR's implementation.
    const cursorResponse = await get(`afterId=${ids.at(-1)}`)
    const supportsCursor = (await cursorResponse.json()).length === 0
    const modes = [{ query: 'since=2026-11-05T12:00:00Z', expected: ids.slice().reverse() }]
    if (supportsCursor) modes.push({ query: 'afterId=0', expected: cursorIds })
    for (const mode of modes) {
      const filters = `repo=forge&ticket=TASK&type=transition&${mode.query}`
      for (const [limit, count] of [[undefined, 100], ['1', 1], ['007', 7], ['101', 101], ['1000', 1000], ['1001', 1000], ['9007199254740991', 1000]] as const) {
        const response = await get(filters + (limit === undefined ? '' : `&limit=${limit}`))
        assert.equal(response.status, 200)
        const rows = await response.json() as { id: number }[]
        assert.deepEqual(rows.map(row => row.id), mode.expected.slice(0, count))
      }
      for (const value of ['', '0', '-1', '1.5', '1junk', '1e2', '0x10', '%20', '%201', '1%20', '%2B1', 'NaN', 'Infinity', '9007199254740992', '999999999999999999999999']) {
        const response = await get(`${filters}&limit=${value}`)
        assert.equal(response.status, 400, value)
        assert.match(response.headers.get('content-type')!, /application\/json/)
        assert.match((await response.json()).error, /limit/)
      }
      for (const query of ['limit=1&limit=2', 'limit[]=1', 'limit[x]=1', 'limit=1&limit[x]=2']) {
        const response = await get(`${filters}&${query}`)
        assert.equal(response.status, 400, query)
        assert.match((await response.json()).error, /limit/)
      }
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(directory, { recursive: true, force: true })
  }
})
