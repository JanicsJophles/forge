import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('task history pages by exclusive chronological anchor with stable ties and filters', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-history-pages-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = join(directory, 'no-env-file')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  t.after(() => db.close())
  const insert = db.prepare(`INSERT INTO tasks (id, repo, branch, prompt, status, created_at, log)
    VALUES (?, ?, 'test', 'test', ?, ?, ?)`)
  const repo = "/stored/a+b?x=1&quote='_%"
  const expected: string[] = []
  for (let i = 0; i < 23; i++) {
    // Mixed text representations of equal instants, plus distinct days.
    const timestamp = `2026-11-${i < 8 ? '03' : i < 16 ? '04' : '05'}`
      + (i % 2 ? 'T12:00:00Z' : ' 12:00:00')
    insert.run('other-' + i, '/other', 'failed', timestamp, '')
    insert.run('completed-' + i, repo, 'completed', timestamp, '')
    const id = i === 10 ? "id' OR 1=1 --" : 'match-' + i
    insert.run(id, repo, 'failed', timestamp, i % 2 ? null : '')
    expected.unshift(id)
  }
  const server = express().use('/tasks', tasksRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve())
    server.closeAllConnections()
  }))
  const { port } = server.address() as { port: number }
  const get = (query: string) => fetch(`http://127.0.0.1:${port}/tasks?${query}`)
  const filters = `repo=${encodeURIComponent(repo)}&status=failed&limit=7`
  const caught: string[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const response = await get(filters + (cursor ? '&before=' + encodeURIComponent(cursor) : ''))
    assert.equal(response.status, 200)
    const rows = await response.json() as { id: string; log: string; logBytes: number }[]
    assert.deepEqual(rows.map(row => row.id), expected.slice(caught.length, caught.length + 7))
    assert.ok(rows.every(row => row.log === '' && row.logBytes === 0))
    caught.push(...rows.map(row => row.id))
    cursor = response.headers.get('x-next-before')
    if (cursor) assert.equal(cursor, rows.at(-1)!.id)
    if (pages === 0) insert.run('newer', repo, 'failed', '2026-11-06T12:00:00Z', '')
    assert.ok(++pages <= 4, 'pagination terminates')
  } while (cursor)
  assert.equal(pages, 4)
  assert.deepEqual(caught, expected)
  assert.equal(new Set(caught).size, expected.length)
  const allExpected = ['newer', ...expected.flatMap((id, index) => {
    const i = 22 - index
    return [id, 'completed-' + i, 'other-' + i]
  })]
  const allCaught: string[] = []
  cursor = null
  do {
    const response = await get('limit=9' + (cursor ? '&before=' + encodeURIComponent(cursor) : ''))
    assert.equal(response.status, 200)
    const rows = await response.json() as { id: string }[]
    allCaught.push(...rows.map(row => row.id))
    cursor = response.headers.get('x-next-before')
    assert.ok(allCaught.length <= allExpected.length)
  } while (cursor)
  assert.deepEqual(allCaught, allExpected)
  // Anchors need not match the filters; their position still defines the boundary.
  const outside = await get(filters + '&before=completed-22')
  assert.deepEqual((await outside.json()).map((row: { id: string }) => row.id), expected.slice(1, 8))
  const end = await get(filters + '&before=match-0')
  assert.deepEqual(await end.json(), [])
  assert.equal(end.headers.get('x-next-before'), null)
  for (const query of ['before=', 'before=%20', 'before=a&before=b', 'before[]=a', 'before[x]=a',
    'repo=', 'repo=a&repo=b', 'repo[x]=a', 'status=', 'status=FAILED', 'status[]=failed']) {
    const response = await get(query)
    assert.equal(response.status, 400, query)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    assert.equal(typeof (await response.json()).error, 'string')
  }
  for (const id of ['missing', "' OR 1=1 --"]) {
    const response = await get('before=' + encodeURIComponent(id))
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'before task not found' })
  }
  for (const value of [repo + '/', repo.toUpperCase(), '%', "' OR 1=1 --"]) {
    assert.deepEqual(await (await get('repo=' + encodeURIComponent(value))).json(), [])
  }
  for (const [query, count] of [
    ['', 20], ['limit=1', 1], ['limit=999', 70], ['limit=0', 1], ['limit=-5', 1],
    ['limit=5.9', 5], ['limit=abc', 20], ['limit=Infinity', 20],
    ['limit=5&limit=10', 20], ['limit[x]=5', 20],
  ] as const) {
    const response = await get(query)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).length, count, query)
  }
  for (let i = 0; i < 40; i++) insert.run('extra-' + i, '/extra', 'queued', '2026-11-07 12:00:00', '')
  assert.equal((await (await get('limit=999')).json()).length, 100)
})
