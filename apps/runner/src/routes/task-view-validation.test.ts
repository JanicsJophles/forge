import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'

// GET /tasks/:id?view=<x> treats only 'status' and 'detail' as projections. Any
// other view value must be rejected with 400 before any DB read, rather than
// silently returning the full task (entire log + prompt) — a disclosure footgun.
test('GET /tasks/:id rejects an unknown view with 400 before any DB read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-view-validation-'))
  process.env.DATA_DIR = dir
  const { tasksRouter } = await import('./tasks.js')
  const { insertTask } = await import('../db/queries.js')
  const { db } = await import('../db/schema.js')
  const app = express().use('/tasks', tasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as import('node:net').AddressInfo
  const base = `http://127.0.0.1:${address.port}/tasks/`

  // Spy on db.prepare so we can prove an invalid view short-circuits before any
  // task SELECT runs against the database.
  const originalPrepare = db.prepare
  const selects: string[] = []
  let inspect = false
  db.prepare = function (sql: string) {
    if (inspect && /^\s*SELECT\b/i.test(sql)) selects.push(sql)
    return originalPrepare.call(this, sql)
  } as typeof db.prepare

  const prompt = 'secret prompt text that the full task would expose'
  insertTask({
    id: 'present', provider: 'claude', repo: dir, branch: 'test', prompt,
    status: 'completed', log: 'line one\nline two\n', createdAt: new Date().toISOString(),
  })

  async function get(path: string, query = '') {
    selects.length = 0
    inspect = true
    let response: Response
    try {
      response = await fetch(base + path + query)
    } finally {
      inspect = false
    }
    return response
  }

  try {
    // No view → the full task, unchanged: full prompt + full log, not a projection.
    {
      const response = await get('present')
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.id, 'present')
      assert.equal(body.prompt, prompt)
      assert.equal(body.log, 'line one\nline two\n')
      assert.equal('read_projection_version' in body, false)
      assert.ok(selects.length >= 1)
    }

    // view=status → the status projection: no log, no prompt.
    {
      const response = await get('present', '?view=status')
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.id, 'present')
      assert.equal(body.read_projection_version, 1)
      assert.equal(body.log, undefined)
      assert.equal(body.prompt, undefined)
    }

    // view=detail → the detail projection: a bounded log tail (present here since
    // the fixture log is short) plus projection metadata. Do NOT assert log is
    // undefined — the projection intentionally returns the tail as `log`.
    {
      const response = await get('present', '?view=detail')
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.id, 'present')
      assert.equal(body.read_projection_version, 1)
      assert.equal(body.log, 'line one\nline two\n')
      assert.equal(typeof body.logBytes, 'number')
      assert.equal(body.logTruncated, false)
    }

    // Unknown view values are rejected with 400 — and no task SELECT runs.
    for (const bad of ['statuss', 'detailx', 'full', 'STATUS', '']) {
      const response = await get('present', `?view=${bad}`)
      assert.equal(response.status, 400, `view=${bad}`)
      const body = await response.json()
      assert.equal(typeof body.error, 'string', `view=${bad}`)
      assert.equal(selects.length, 0, `view=${bad} must not read the DB`)
    }

    // A repeated view (parsed as an array) is likewise rejected before any read.
    {
      const response = await get('present', '?view=status&view=detail')
      assert.equal(response.status, 400)
      assert.equal(selects.length, 0)
    }

    // A missing task still 404s for absent/status/detail views...
    for (const query of ['', '?view=status', '?view=detail']) {
      const response = await get('missing', query)
      assert.equal(response.status, 404, `missing ${query}`)
      assert.deepEqual(await response.json(), { error: 'task not found' })
    }

    // ...but an invalid view wins over the 404: it is rejected before the lookup.
    {
      const response = await get('missing', '?view=bogus')
      assert.equal(response.status, 400)
      assert.equal(selects.length, 0)
    }
  } finally {
    db.prepare = originalPrepare
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
