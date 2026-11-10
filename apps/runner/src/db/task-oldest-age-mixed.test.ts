import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'

test('oldest running age normalizes every timestamp before taking the minimum', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-oldest-age-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('./schema.js')
  const clock = new Database(':memory:')
  try {
    const { oldestRunningTaskAgeSeconds } = await import('./queries.js')
    // Keep real SQLite parsing and arithmetic, replacing only its wall clock.
    // Half-second basis avoids floating-point rounding at whole-second boundaries.
    const julianDay = clock.prepare('SELECT julianday(?) AS day')
    db.function('julianday', (value: unknown) => {
      const { day } = julianDay.get(value === 'now' ? '2026-11-10 12:00:00.500' : value) as {
        day: number | null
      }
      return day
    })
    const insert = db.prepare(`
      INSERT INTO tasks (id, repo, branch, prompt, status, started_at)
      VALUES (?, 'forge', 'test', 'fixture', ?, ?)
    `)
    const cases: { name: string; times: (string | null)[]; expected: number | null }[] = [
      { name: 'empty', times: [], expected: null },
      { name: 'same-day ISO older than SQLite', times: [
        '2026-11-10 02:00:00', '2026-11-10T01:00:00Z',
      ], expected: 39600 },
      { name: 'positive offset changes oldest instant', times: [
        '2026-11-10 02:00:00', '2026-11-10T03:00:00+03:00',
      ], expected: 43200 },
      { name: 'negative offset changes oldest instant', times: [
        '2026-11-10T01:00:00-03:00', '2026-11-10 02:00:00',
      ], expected: 36000 },
      { name: 'fractional seconds are floored', times: [
        '2026-11-10 11:59:59.750', '2026-11-10T11:59:58.250Z',
      ], expected: 2 },
      { name: 'invalid and null ignored beside usable timestamp', times: [
        '!invalid', null, '2026-11-10T11:59:58.250Z',
      ], expected: 2 },
      { name: 'no usable timestamp', times: ['!invalid', null], expected: null },
      { name: 'future clamps to zero', times: ['2026-11-11T00:00:00Z'], expected: 0 },
    ]
    for (const { name, times, expected } of cases) {
      db.exec('DELETE FROM tasks')
      // Neither terminal nor queued rows may influence the aggregate.
      for (const status of ['completed', 'failed', 'cancelled', 'queued']) {
        insert.run(status, status, '2000-01-01 00:00:00')
      }
      times.forEach((time, index) => insert.run(`running-${index}`, 'running', time))
      assert.equal(oldestRunningTaskAgeSeconds(), expected, name)
    }
    db.close()
    assert.equal(oldestRunningTaskAgeSeconds(), null, 'database failures degrade to null')
  } finally {
    if (db.open) db.close()
    clock.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    rmSync(directory, { recursive: true, force: true })
  }
})
