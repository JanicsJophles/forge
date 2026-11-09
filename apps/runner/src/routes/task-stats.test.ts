import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('GET /tasks/stats returns grouped status counts without shadowing /:id', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-stats-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = path.join(directory, 'no-env-file')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  t.after(() => db.close())

  const server = express().use('/tasks', tasksRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const { port } = address
  async function get(route: string, expectedStatus = 200) {
    const response = await fetch(`http://127.0.0.1:${port}/tasks${route}`)
    assert.equal(response.status, expectedStatus, route)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    return response.json()
  }

  // Empty table: every bucket and the total are zero.
  assert.deepEqual(await get('/stats'), { queued: 0, running: 0, completed: 0, failed: 0, total: 0 })

  const insert = db.prepare(`
    INSERT INTO tasks (id, repo, branch, prompt, status, created_at, log)
    VALUES (?, '/repo', 'test', 'test', ?, '2026-11-05T09:00:00Z', 'log')
  `)
  // 2 queued, 1 running, 3 completed, 2 failed → total 8
  insert.run('q1', 'queued')
  insert.run('q2', 'queued')
  insert.run('r1', 'running')
  insert.run('c1', 'completed')
  insert.run('c2', 'completed')
  insert.run('c3', 'completed')
  insert.run('f1', 'failed')
  insert.run('f2', 'failed')

  const stats = await get('/stats')
  assert.deepEqual(stats, { queued: 2, running: 1, completed: 3, failed: 2, total: 8 })
  for (const value of Object.values(stats)) {
    assert.ok(Number.isInteger(value) && value >= 0)
  }
  assert.equal(stats.total, stats.queued + stats.running + stats.completed + stats.failed)

  // /:id is not shadowed by /stats, and unknown ids still 404.
  assert.equal((await get('/c1')).id, 'c1')
  assert.equal(typeof (await get('/no-such-task', 404)).error, 'string')
})
