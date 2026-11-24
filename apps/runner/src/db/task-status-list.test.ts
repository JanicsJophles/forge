import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { readTaskStatusList } from './task-projection.js'

test('status list projects the newest 20 tasks without loading large logs or prompts', () => {
  const queries: string[] = []
  const db = new Database(':memory:', { verbose: sql => queries.push(String(sql)) })
  try {
    db.exec(`CREATE TABLE tasks(id, repo, status, created_at, started_at, completed_at, provider, log, prompt)`)
    const insert = db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (let i = 0; i < 21; i++) {
      insert.run(`task-${i}`, '/opt/repos/brain', i === 20 ? 'running' : 'completed',
        `2026-11-23T20:${String(i).padStart(2, '0')}:00Z`, null, null, 'codex',
        i === 20 ? '😀'.repeat(1_100_000) : '', 'private prompt')
    }
    queries.length = 0
    const rows = readTaskStatusList(db)
    assert.equal(rows.length, 20)
    assert.equal(rows[0].id, 'task-20')
    assert.equal(rows[0].repo, '/opt/repos/brain')
    assert.equal(rows[0].status, 'running')
    assert.equal(rows[0].provider, 'codex')
    assert.equal(rows[0].read_projection_version, 1)
    assert.equal(rows.at(-1)?.id, 'task-1')
    assert.doesNotMatch(queries.at(-1)!, /\blog\b|\bprompt\b|SELECT\s+\*/i)
    assert.match(queries.at(-1)!, /LIMIT 20/)
    assert.ok(Buffer.byteLength(JSON.stringify(rows)) < 10_000)
    assert.ok(!JSON.stringify(rows).includes('private prompt'))
  } finally { db.close() }
})

test('status list supports empty results and legacy schemas without a provider', () => {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE tasks(id, repo, status, created_at, started_at, completed_at)')
    assert.deepEqual(readTaskStatusList(db), [])
    db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)').run('one', 'brain', 'failed', 'created', 'started', 'finished')
    assert.deepEqual(readTaskStatusList(db), [{ id: 'one', repo: 'brain', status: 'failed', createdAt: 'created', startedAt: 'started', completedAt: 'finished', read_projection_version: 1 }])
  } finally { db.close() }
})
