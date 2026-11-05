import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('task lists order mixed timestamps by instant before applying limits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-task-order-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('./schema.js')
  try {
    const { listTasks, listActiveTasks, LIST_LOG_TAIL_BYTES } = await import('./queries.js')
    const insert = db.prepare(`
      INSERT INTO tasks (id, repo, branch, prompt, status, log, created_at)
      VALUES (?, 'forge', 'test', ?, ?, ?, ?)
    `)
    const times = [
      '2026-11-05T09:00:00.000Z',
      '2026-11-05 12:00:00',
      '2026-11-05T12:00:00.001Z',
      '2026-11-05T14:00:00.123+02:00',
      '2026-11-05T07:00:00.123-05:00',
      '2026-11-05 12:00:00.124',
      '2026-11-05 18:00:00',
    ]
    const log = 'x'.repeat(LIST_LOG_TAIL_BYTES + 100)
    times.forEach((time, index) => insert.run(
      `task-${index}`, '  private\n' + 'p'.repeat(200),
      index % 2 ? 'running' : 'queued', log, time,
    ))
    const expectedIds = times.map((_, index) => `task-${index}`).reverse()
    const history = listTasks()
    assert.deepEqual(history.map(task => task.id), expectedIds)
    assert.deepEqual(history.map(task => task.createdAt), [...times].reverse())
    for (const limit of [0, 1, 3, 5, 7]) {
      assert.deepEqual(listTasks(limit).map(task => task.id), expectedIds.slice(0, limit))
    }
    assert.equal(history[0].log, 'x'.repeat(LIST_LOG_TAIL_BYTES))
    assert.equal(history[0].logBytes, log.length)
    assert.equal(history[0].logTruncated, true)

    for (const status of ['completed', 'failed', 'cancelled']) {
      insert.run(status, 'hidden prompt', status, 'hidden log', '2026-11-06T00:00:00Z')
    }
    const active = listActiveTasks()
    assert.deepEqual(active.map(task => task.id), expectedIds)
    assert.deepEqual(active.map(task => task.createdAt), [...times].reverse())
    assert.equal(active[0].promptSnippet.length, 120)
    assert.equal(active[0].promptSnippet, 'private ' + 'p'.repeat(111) + '…')
    assert.equal('log' in active[0], false)
    assert.equal('prompt' in active[0], false)
  } finally {
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    rmSync(directory, { recursive: true, force: true })
  }
})
