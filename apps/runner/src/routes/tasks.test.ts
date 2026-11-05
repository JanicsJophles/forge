import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('GET /tasks bounds the requested history size', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-task-list-'))
  process.env.DATA_DIR = dataDir
  process.env.ALLOWED_REPO_PATHS = dataDir
  process.env.DOTENV_CONFIG_PATH = path.join(dataDir, 'no-env-file')
  t.after(() => rm(dataDir, { recursive: true, force: true }))

  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  t.after(() => db.close())
  const insert = db.prepare(`INSERT INTO tasks (id, repo, branch, prompt, status)
    VALUES (?, '/test', 'test', 'test', 'completed')`)
  for (let i = 0; i < 105; i++) insert.run(String(i))

  const app = express()
  app.use('/tasks', tasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  for (const [query, expected] of [
    ['', 20], ['?limit=5', 5], ['?limit=999', 100], ['?limit=100', 100],
    ['?limit=0', 1], ['?limit=-5', 1], ['?limit=5.9', 5],
    ['?limit=abc', 20], ['?limit=5abc', 20], ['?limit=', 20],
    ['?limit=Infinity', 20], ['?limit=NaN', 20],
    ['?limit=5&limit=10', 20], ['?limit[x]=5', 20],
  ] as const) {
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks${query}`)
    assert.equal(response.status, 200, query)
    const tasks = await response.json() as unknown[]
    assert.equal(tasks.length, expected, query)
  }
})
