import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('active summaries expose saved nullable starts independently of creation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-active-start-'))
  const previous = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('./schema.js')
  const { listActiveTasks } = await import('./queries.js')
  try {
    const insert = db.prepare(`INSERT INTO tasks
      (id, repo, branch, prompt, status, created_at, started_at)
      VALUES (?, '/repo', 'test', 'work', ?, '2026-11-05 09:00:00', ?)`)
    insert.run('queued', 'queued', null)
    insert.run('running', 'running', '2026-11-05 11:59:00')
    insert.run('zoned', 'running', '2026-11-05T13:59:00+02:00')
    insert.run('legacy', 'running', null)
    insert.run('terminal', 'completed', '2026-11-05 10:00:00')
    const rows = new Map(listActiveTasks().map(row => [row.id, row]))
    assert.equal(rows.size, 4)
    assert.equal(rows.get('queued')!.startedAt, null)
    assert.equal(rows.get('legacy')!.startedAt, null)
    assert.equal(rows.get('running')!.startedAt, '2026-11-05 11:59:00')
    assert.equal(rows.get('zoned')!.startedAt, '2026-11-05T13:59:00+02:00')
    db.prepare("UPDATE tasks SET status = 'running', started_at = '2026-11-05 12:00:00' WHERE id = 'queued'").run()
    const transitioned = listActiveTasks().find(row => row.id === 'queued')!
    assert.equal(transitioned.startedAt, '2026-11-05 12:00:00')
    assert.equal(transitioned.createdAt, '2026-11-05 09:00:00')
  } finally {
    db.close()
    if (previous === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
