import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('history filters exact stored values before ordering and limiting', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-history-filter-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = path.join(directory, 'no-env-file')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  t.after(() => db.close())
  const insert = db.prepare(`
    INSERT INTO tasks (id, repo, branch, prompt, status, created_at, log)
    VALUES (?, ?, 'test', 'test', ?, ?, 'history log')
  `)
  const repo = "/stored checkout/a+b?x=1&quote='_%"
  insert.run('old-failure', repo, 'failed', '2026-11-05T09:00:00Z')
  insert.run('sqlite-failure', repo, 'failed', '2026-11-05 12:00:00')
  insert.run('tie-failure', repo, 'failed', '2026-11-05T12:00:00Z')
  insert.run('completed', repo, 'completed', '2026-11-05T13:00:00Z')
  insert.run('queued', repo, 'queued', '2026-11-05T14:00:00Z')
  insert.run('running', repo, 'running', '2026-11-05T15:00:00Z')
  insert.run('other-failure', '/other', 'failed', '2026-11-06T00:00:00Z')
  for (let i = 0; i < 105; i++) {
    insert.run('new-' + i, '/other', 'completed', '2026-11-07T00:00:00Z')
  }

  const server = express().use('/tasks', tasksRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  async function get(query: string, expectedStatus = 200) {
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks${query}`)
    assert.equal(response.status, expectedStatus, query)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    return response.json()
  }
  const encoded = encodeURIComponent(repo)
  const failures = await get('?repo=' + encoded + '&status=failed')
  assert.deepEqual(failures.map((task: any) => task.id), ['tie-failure', 'sqlite-failure', 'old-failure'])
  assert.equal(failures[0].log, 'history log')
  assert.equal(failures[0].createdAt, '2026-11-05T12:00:00Z')
  assert.deepEqual((await get('?repo=' + encoded + '&status=failed&limit=1')).map((task: any) => task.id), ['tie-failure'])
  assert.equal((await get('?repo=' + encoded)).length, 6)
  assert.equal((await get('?status=failed')).length, 4)
  for (const status of ['queued', 'running', 'completed']) {
    const rows = await get('?repo=' + encoded + '&status=' + status)
    assert.deepEqual(rows.map((task: any) => task.status), [status])
  }
  for (const value of [repo + '/', repo.toUpperCase(), "' OR 1=1 --", '%', '/missing']) {
    assert.deepEqual(await get('?repo=' + encodeURIComponent(value)), [])
  }
  for (const query of [
    '?repo=', '?repo=%20', '?repo=a&repo=b', '?repo[x]=a', '?repo[]=a',
    '?status=', '?status=cancelled', '?status=FAILED', '?status=%20failed',
    '?status=failed&status=failed', '?status[x]=failed', '?status[]=failed',
    '?status=' + encodeURIComponent("' OR 1=1 --"),
  ]) {
    assert.equal(typeof (await get(query, 400)).error, 'string', query)
  }
  for (const [query, count] of [
    ['', 20], ['?limit=1', 1], ['?limit=999', 100], ['?limit=0', 1],
    ['?limit=-5', 1], ['?limit=5.9', 5], ['?limit=abc', 20],
    ['?limit=Infinity', 20], ['?limit=5&limit=10', 20], ['?limit[x]=5', 20],
  ] as const) {
    const rows = await get(query)
    assert.ok(Array.isArray(rows))
    assert.equal(rows.length, count, query)
    assert.equal(rows[0].id, 'new-104')
  }
})
