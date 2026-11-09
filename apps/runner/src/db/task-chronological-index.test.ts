import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'

function initialize(directory: string) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `const { db } = await import(${JSON.stringify(new URL('./schema.ts', import.meta.url).href)}); db.close()`], {
    env: { ...process.env, DATA_DIR: directory }, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
}

function chronologicalIndexes(db: Database.Database) {
  return db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'tasks_%chronological_idx' ORDER BY name").all()
}

test('fresh task lists use chronological indexes without temporary sorts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-chronological-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('./schema.js')
  try {
    const { listTasks, listActiveTasks, countActiveTasks } = await import('./queries.js')
    assert.equal(chronologicalIndexes(db).length, 2)
    const insert = db.prepare(`INSERT INTO tasks (id, repo, branch, prompt, status, created_at)
      VALUES (?, 'forge', 'test', 'test prompt', ?, ?)`)
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        insert.run(`terminal-${i}`, ['completed', 'failed', 'cancelled'][i % 3], '2026-11-04 12:00:00')
      }
      const times = [
        '2026-11-05T09:00:00.000Z',
        '2026-11-05 12:00:00',
        '2026-11-05T12:00:00.001Z',
        '2026-11-05T14:00:00.123+02:00',
        '2026-11-05T07:00:00.123-05:00',
        '2026-11-05 12:00:00.124',
      ]
      times.forEach((time, i) => insert.run(`live-${i}`, i % 2 ? 'queued' : 'running', time))
    })()

    // Explain the actual production SQL, including its projections and predicate.
    const prepare = db.prepare
    const plans: string[][] = []
    db.prepare = function (sql: string) {
      if (/SELECT id, repo, branch|SELECT COUNT\(\*\) as count/.test(sql)) {
        const parameters = sql.includes('LIMIT ?') ? [6] : []
        const rows = prepare.call(db, `EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as { detail: string }[]
        plans.push(rows.map(row => row.detail))
      }
      return prepare.call(db, sql)
    } as typeof db.prepare
    try {
      const expected = [5, 4, 3, 2, 1, 0].map(i => `live-${i}`)
      assert.deepEqual(listTasks(6).map(task => task.id), expected)
      assert.deepEqual(listActiveTasks().map(task => task.id), expected)
      assert.equal(countActiveTasks(), 6)
    } finally {
      db.prepare = prepare
    }
    assert.equal(plans.length, 3)
    for (const [i, index] of ['tasks_chronological_idx', 'tasks_live_chronological_idx', 'tasks_live_chronological_idx'].entries()) {
      assert.ok(plans[i].some(detail => detail.includes(`USING INDEX ${index}`)), plans[i].join('\n'))
      assert.ok(plans[i].every(detail => !detail.includes('USE TEMP B-TREE')), plans[i].join('\n'))
    }
    const before = db.prepare('SELECT rowid, * FROM tasks ORDER BY rowid').all()
    // Leave only terminal rows so unchanged startup reconciliation has nothing to update.
    db.prepare("UPDATE tasks SET status = 'completed' WHERE status IN ('queued', 'running')").run()
    const terminal = db.prepare('SELECT rowid, * FROM tasks ORDER BY rowid').all()
    assert.equal(before.length, terminal.length)
    initialize(directory)
    initialize(directory)
    assert.deepEqual(db.prepare('SELECT rowid, * FROM tasks ORDER BY rowid').all(), terminal)
    assert.equal(chronologicalIndexes(db).length, 2)
  } finally {
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    rmSync(directory, { recursive: true, force: true })
  }
})

test('existing task databases gain chronological indexes idempotently without changing rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-existing-chronological-'))
  const db = new Database(join(directory, 'forge.db'))
  try {
    db.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT NOT NULL, prompt TEXT NOT NULL,
      status TEXT DEFAULT 'queued', log TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT, completed_at TEXT, error_message TEXT, commit_sha TEXT,
      provider TEXT NOT NULL DEFAULT 'claude', auto_commit INTEGER, model TEXT
    );
    CREATE INDEX tasks_created_idx ON tasks(created_at DESC);
    CREATE INDEX tasks_status_idx ON tasks(status);
    INSERT INTO tasks (id, repo, branch, prompt, status, created_at)
      VALUES ('existing', 'forge', 'test', 'preserve me', 'completed', '2026-11-05T14:00:00+02:00');`)
    const before = db.prepare('SELECT rowid, * FROM tasks').all()
    assert.equal(chronologicalIndexes(db).length, 0)
    initialize(directory)
    const indexes = chronologicalIndexes(db)
    assert.equal(indexes.length, 2)
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'tasks_status_idx'").get(), undefined)
    initialize(directory)
    assert.deepEqual(chronologicalIndexes(db), indexes)
    assert.deepEqual(db.prepare('SELECT rowid, * FROM tasks').all(), before)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
