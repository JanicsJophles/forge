import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('checkpoint bounds TTL on insert and renewal while preserving board fields', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'forge-checkpoint-ttl-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = dataDir
  const { db } = await import('./schema.js')
  const { checkpoint, listAgentState } = await import('./agent-state.js')
  t.after(() => {
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    rmSync(dataDir, { recursive: true, force: true })
  })

  let now = Date.parse('2026-11-05T12:00:00.000Z')
  const sqliteTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
  t.mock.method(Date, 'now', () => now)
  // Freeze SQLite's clock too, so live/expired boundary checks are deterministic.
  db.function('datetime', (value: string) => value === 'now' ? sqliteTime(now) : value)

  const cases: [string, number | undefined, number][] = [
    ['missing', undefined, 3600],
    ['negative', -100, 60],
    ['zero', 0, 60],
    ['fractional', 123.9, 123],
    ['below-minimum', 59.9, 60],
    ['fleet', 7200, 7200],
    ['maximum', 604800, 604800],
    ['above-maximum', 604801, 604800],
    ['huge', 1e300, 604800],
    ['nan', NaN, 3600],
    ['positive-infinity', Infinity, 3600],
    ['negative-infinity', -Infinity, 3600],
  ]

  for (const [agentId, ttlSeconds, expectedTtl] of cases) {
    const fields = {
      agentType: 'forge', repo: 'forge', branch: 'fleet/forge/test',
      intent: 'testing', filesTouched: ['example.ts'], ticket: 'FORGE-1',
      status: 'testing', metadata: { lane: 'forge' },
    }
    const inserted = checkpoint({ agentId, ...fields, ttlSeconds })
    assert.equal(inserted.expiresAt, sqliteTime(now + expectedTtl * 1000), agentId)
    assert.match(inserted.expiresAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    assert.equal((db.prepare('SELECT julianday(?) AS value').get(inserted.expiresAt) as { value: number }).value > 0, true)
    assert.ok(listAgentState().some(row => row.agentId === agentId))

    now += expectedTtl * 1000
    assert.ok(!listAgentState().some(row => row.agentId === agentId), `${agentId} expires at boundary`)
    assert.ok(listAgentState({ includeExpired: true }).some(row => row.agentId === agentId))

    const renewed = checkpoint({ agentId, ttlSeconds })
    assert.equal(renewed.expiresAt, sqliteTime(now + expectedTtl * 1000), agentId)
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      assert.deepEqual(renewed[key], fields[key], `${agentId} preserves ${key}`)
    }
    assert.deepEqual(Object.keys(renewed), Object.keys(inserted))
    assert.ok(!('expires_at' in renewed))
    assert.ok(listAgentState().some(row => row.agentId === agentId))
    now += expectedTtl * 1000
    assert.ok(!listAgentState().some(row => row.agentId === agentId))
  }
})
