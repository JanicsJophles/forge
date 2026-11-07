import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'

test('GET /tasks/:id rejects an unknown view and still serves full + projection views', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-view-validation-'))
  process.env.DATA_DIR = dir
  process.env.DOTENV_CONFIG_PATH = join(dir, 'no-env-file')
  process.env.ALLOWED_REPO_PATHS = dir
  const { tasksRouter } = await import('./tasks.js')
  const { insertTask } = await import('../db/queries.js')
  const { db } = await import('../db/schema.js')
  const app = express().use('/tasks', tasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as import('node:net').AddressInfo
  const base = `http://127.0.0.1:${address.port}/tasks`
  try {
    insertTask({ id: 'view', repo: dir, branch: 'test', prompt: 'the full prompt',
      status: 'completed', log: 'the full transcript\n', createdAt: new Date().toISOString() })

    // An absent view returns the full task, including the whole log and prompt.
    const full = await fetch(`${base}/view`)
    assert.equal(full.status, 200)
    const fullBody = await full.json() as { id: string; log: string; prompt: string }
    assert.equal(fullBody.id, 'view')
    assert.equal(fullBody.log, 'the full transcript\n')
    assert.equal(fullBody.prompt, 'the full prompt')

    // The two known projections still succeed and are bounded (no raw log/prompt).
    for (const view of ['status', 'detail']) {
      const response = await fetch(`${base}/view?view=${view}`)
      assert.equal(response.status, 200, view)
      const body = await response.json() as { id: string; log?: string }
      assert.equal(body.id, 'view')
      assert.equal(body.log, undefined, view)
    }

    // A present-but-unknown view is rejected with 400 before any DB read — even a
    // typo of a valid value must not fall back to the full task.
    for (const view of ['statuss', 'detailx', 'full', 'STATUS', '', 'status ']) {
      const response = await fetch(`${base}/view?view=${encodeURIComponent(view)}`)
      assert.equal(response.status, 400, JSON.stringify(view))
      assert.equal(typeof (await response.json() as { error: string }).error, 'string')
    }
    // Array/object shapes of the query are unknown views too, not valid projections.
    for (const query of ['view[]=status', 'view=status&view=detail', 'view[x]=status']) {
      const response = await fetch(`${base}/view?${query}`)
      assert.equal(response.status, 400, query)
    }

    // A missing task still returns 404 for the full view and both projections; an
    // unknown view is rejected before the existence check even runs.
    for (const suffix of ['', '?view=status', '?view=detail']) {
      assert.equal((await fetch(`${base}/missing${suffix}`)).status, 404, suffix)
    }
    assert.equal((await fetch(`${base}/missing?view=statuss`)).status, 400)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
