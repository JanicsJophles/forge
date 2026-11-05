import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('listEvents normalizes catch-up bounds in a throwaway SQLite database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-agent-state-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  // Import only after isolating DATA_DIR; never open the runner's real DB.
  const { db } = await import('./schema.js')
  try {
    const { listEvents } = await import('./agent-state.js')
    const insert = db.prepare(`
      INSERT INTO agent_events (event_type, repo, ticket, created_at)
      VALUES (?, ?, ?, ?)
    `)
    const times = [
      '2026-11-04 23:59:59',
      '2026-11-05 00:00:00',
      '2026-11-05 11:59:59',
      '2026-11-05 12:00:00',
      '2026-11-05 12:00:01',
      '2026-11-06 00:00:00',
    ]
    for (const time of times) insert.run('pr_opened', 'forge', 'FORGE-1', time)
    const timestamps = (since: string) => listEvents({ since }).map(event => event.createdAt)
    const expected = times.slice(3).reverse()
    for (const since of [
      '2026-11-05T12:00:00Z',
      '2026-11-05T12:00:00.000Z',
      '2026-11-05T14:00:00+02:00',
      '2026-11-05T07:00:00-05:00',
      '2026-11-05 12:00:00',
    ]) {
      assert.deepEqual(timestamps(since), expected, since)
    }
    assert.deepEqual(timestamps('2026-11-05T01:00:00+01:00'), times.slice(1).reverse())
    assert.deepEqual(timestamps('2026-11-04T19:00:00-05:00'), times.slice(1).reverse())
    assert.deepEqual(timestamps('2026-11-05T12:00:00.500Z'), times.slice(4).reverse())
    for (const since of ['invalid', '2026-99-99T99:99:99Z']) {
      assert.deepEqual(timestamps(since), [], since)
    }
    assert.equal(listEvents().length, times.length)
    assert.equal(listEvents({ since: '' }).length, times.length)

    insert.run('pr_opened', 'brain', 'FORGE-1', '2026-11-06 01:00:00')
    insert.run('pr_opened', 'forge', 'FORGE-2', '2026-11-06 02:00:00')
    insert.run('pr_merged', 'forge', 'FORGE-1', '2026-11-06 03:00:00')
    const filter = {
      since: '2026-11-05T12:00:00Z', repo: 'forge', ticket: 'FORGE-1', eventType: 'pr_opened',
    }
    assert.deepEqual(listEvents(filter).map(event => event.createdAt), expected)
    assert.deepEqual(listEvents({ ...filter, limit: 2 }).map(event => event.createdAt), expected.slice(0, 2))
    assert.equal(listEvents({ ...filter, limit: 0 }).length, 1)
  } finally {
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    rmSync(directory, { recursive: true, force: true })
  }
})
