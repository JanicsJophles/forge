import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'

test('GET /tasks?view=status stays small and leaves the legacy list and task detail compatible', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'forge-status-list-'))
  process.env.DATA_DIR = dir
  process.env.ALLOWED_REPO_PATHS = dir
  const { db } = await import('../db/schema.js')
  const { tasksRouter } = await import('./tasks.js')
  const app = express()
  app.use('/tasks', tasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const log = '😀'.repeat(1_100_000)
    db.prepare(`INSERT INTO tasks(id, repo, branch, prompt, status, log, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('one', dir, 'main', 'private prompt', 'running', log, 'codex')
    const response = await fetch(`${base}/tasks?view=status`)
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.ok(Buffer.byteLength(body) < 1000)
    const rows = JSON.parse(body)
    assert.equal(rows[0].id, 'one')
    assert.equal(rows[0].repo, dir)
    assert.equal(rows[0].status, 'running')
    assert.equal(rows[0].read_projection_version, 1)
    assert.equal(rows[0].log, undefined)
    assert.equal(rows[0].prompt, undefined)
    const full = await (await fetch(`${base}/tasks`)).json() as Array<Record<string, unknown>>
    assert.equal(full[0].log, log)
    assert.equal(full[0].prompt, 'private prompt')
    const detail = await (await fetch(`${base}/tasks/one?view=status`)).json() as Record<string, unknown>
    assert.equal(detail.id, 'one')
    assert.equal(detail.log, undefined)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
