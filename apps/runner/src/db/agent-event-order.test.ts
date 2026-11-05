import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('listEvents keeps newest same-second events at the history limit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-agent-event-order-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  // Import only after isolation so this test cannot open the runner's database.
  const { db } = await import('./schema.js')
  try {
    const { listEvents } = await import('./agent-state.js')
    const insert = db.prepare(`
      INSERT INTO agent_events (event_type, repo, ticket, created_at)
      VALUES (?, ?, ?, ?)
    `)
    const ids: number[] = []
    for (let index = 0; index < 250; index++) {
      ids.push(Number(insert.run('pr_opened', 'forge', 'FORGE-1', '2026-11-05 12:00:00').lastInsertRowid))
    }
    const latest = ids.slice().reverse()
    const eventIds = (filter: Parameters<typeof listEvents>[0] = {}) =>
      listEvents(filter).map(event => event.id)
    assert.deepEqual(eventIds({ limit: 200 }), latest.slice(0, 200))
    assert.deepEqual(eventIds(), latest.slice(0, 100))

    // Newer ids from an older second must remain behind the burst.
    const olderId = Number(insert.run('pr_opened', 'forge', 'FORGE-1', '2026-11-05 11:59:59').lastInsertRowid)
    const newerId = Number(insert.run('pr_opened', 'forge', 'FORGE-1', '2026-11-05 12:00:01').lastInsertRowid)
    assert.deepEqual(eventIds({ limit: 1000 }), [newerId, ...latest, olderId])

    // Later nonmatching events must not displace the latest matching transitions.
    insert.run('pr_opened', 'brain', 'FORGE-1', '2026-11-05 12:00:02')
    insert.run('pr_opened', 'forge', 'FORGE-2', '2026-11-05 12:00:02')
    insert.run('pr_merged', 'forge', 'FORGE-1', '2026-11-05 12:00:02')
    const filter = {
      repo: 'forge', ticket: 'FORGE-1', eventType: 'pr_opened',
      since: '2026-11-05T14:00:00.000+02:00', limit: 200,
    }
    assert.deepEqual(eventIds(filter), [newerId, ...latest].slice(0, 200))
    assert.deepEqual(eventIds({ ...filter, limit: 1000 }), [newerId, ...latest])
    assert.deepEqual(eventIds({ ...filter, since: '2026-11-05T12:00:00.500Z' }), [newerId])
    assert.deepEqual(eventIds({ ...filter, since: 'invalid' }), [])
  } finally {
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    rmSync(directory, { recursive: true, force: true })
  }
})
