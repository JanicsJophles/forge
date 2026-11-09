import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { RETENTION_INTERVAL_MS, startTaskRetention } from './retention.js'

// A deterministic fake interval clock, including Node's unref contract.
function fakeClock() {
  let callback: (() => void) | undefined
  let elapsed = 0
  let unrefed = false
  const schedule = ((fn: () => void, ms: number) => {
    assert.equal(ms, 86_400_000)
    callback = fn
    return { unref: () => { unrefed = true } }
  }) as unknown as typeof setInterval
  return {
    schedule,
    get scheduled() { return callback !== undefined },
    get unrefed() { return unrefed },
    tick(ms: number) {
      elapsed += ms
      while (callback && elapsed >= RETENTION_INTERVAL_MS) {
        elapsed -= RETENTION_INTERVAL_MS
        callback()
      }
    },
  }
}

test('disabled retention never prunes or schedules', () => {
  const db = new Database(':memory:')
  try {
    for (const days of [0, -1, 1.5, NaN]) {
      const clock = fakeClock()
      assert.equal(startTaskRetention(db, days, clock.schedule), undefined)
      assert.equal(clock.scheduled, false)
    }
  } finally { db.close() }
})

test('startup and daily pruning preserve live and recent rows', () => {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE tasks (id TEXT, status TEXT, completed_at TEXT)')
    const seed = () => db.exec(`
      INSERT INTO tasks VALUES
        ('old-completed', 'completed', datetime('now', '-31 days')),
        ('old-failed', 'failed', datetime('now', '-31 days'));
    `)
    seed()
    db.exec(`
      INSERT INTO tasks VALUES
        ('recent', 'completed', datetime('now', '-1 day')),
        ('queued', 'queued', datetime('now', '-100 days')),
        ('running', 'running', datetime('now', '-100 days')),
        ('missing-date', 'failed', NULL);
    `)
    const ids = () => db.prepare('SELECT id FROM tasks ORDER BY id').all()
    const clock = fakeClock()
    startTaskRetention(db, 30, clock.schedule)
    assert.equal(clock.unrefed, true)
    const survivors = ids()
    assert.deepEqual(survivors, [
      { id: 'missing-date' }, { id: 'queued' }, { id: 'recent' }, { id: 'running' },
    ])
    seed()
    clock.tick(RETENTION_INTERVAL_MS - 1)
    assert.equal(ids().length, 6)
    clock.tick(1)
    assert.deepEqual(ids(), survivors)
    seed()
    clock.tick(RETENTION_INTERVAL_MS)
    assert.deepEqual(ids(), survivors)
  } finally { db.close() }
})

test('startup and interval failures are contained, redacted, and retried', () => {
  const db = new Database(':memory:')
  const clock = fakeClock()
  const warnings: unknown[][] = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args) }
  try {
    // Missing table fails at startup; a later tick must still run.
    assert.doesNotThrow(() => startTaskRetention(db, 30, clock.schedule))
    assert.equal(clock.unrefed, true)
    clock.tick(RETENTION_INTERVAL_MS)
    assert.deepEqual(warnings, Array(2).fill([
      '[db] Task retention pruning failed; will retry at the next interval.',
    ]))
    db.exec(`CREATE TABLE tasks (status TEXT, completed_at TEXT);
      INSERT INTO tasks VALUES ('failed', datetime('now', '-100 days'));`)
    clock.tick(RETENTION_INTERVAL_MS)
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 0)
    assert.equal(warnings.length, 2)
  } finally {
    console.warn = original
    db.close()
  }
})
