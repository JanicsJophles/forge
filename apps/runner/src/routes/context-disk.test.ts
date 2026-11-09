import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('/agent-context reports a global disk block, unaffected by ?repo=', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-context-disk-'))
  const previousDataDir = process.env.DATA_DIR
  const previousMin = process.env.MIN_FREE_DISK_MB
  const previousAllowed = process.env.ALLOWED_REPO_PATHS
  process.env.DATA_DIR = dataDir
  // A tiny threshold the real filesystem is virtually certain to clear, so
  // diskOk is deterministically true without faking statfs.
  process.env.MIN_FREE_DISK_MB = '1'
  process.env.ALLOWED_REPO_PATHS = dataDir
  const { db } = await import('../db/schema.js')
  const { insertTask } = await import('../db/queries.js')
  const { config } = await import('../config.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    insertTask({ id: 'q1', repo: 'alpha', branch: 'test', prompt: 'x', status: 'queued', log: '', createdAt: new Date().toISOString() })

    const { port } = server.address() as { port: number }
    const snapshot = await (await fetch(`http://127.0.0.1:${port}/agent-context`)).json()
    assert.equal(typeof snapshot.disk.freeDiskMb, 'number')
    assert.ok(snapshot.disk.freeDiskMb >= config.minFreeDiskMb)
    assert.equal(snapshot.disk.diskOk, true)

    // ?repo= narrows the repo-scoped collections but MUST NOT narrow disk
    // (disk headroom is a global runner property, like capacity).
    const filtered = await (await fetch(`http://127.0.0.1:${port}/agent-context?repo=alpha`)).json()
    assert.deepEqual(filtered.disk, snapshot.disk)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    if (previousMin === undefined) delete process.env.MIN_FREE_DISK_MB
    else process.env.MIN_FREE_DISK_MB = previousMin
    if (previousAllowed === undefined) delete process.env.ALLOWED_REPO_PATHS
    else process.env.ALLOWED_REPO_PATHS = previousAllowed
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('/agent-context disk fails open to nulls when the path cannot be stat\'d', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-context-disk-fail-'))
  const previousDataDir = process.env.DATA_DIR
  const previousAllowed = process.env.ALLOWED_REPO_PATHS
  process.env.DATA_DIR = dataDir
  // A non-existent path makes statfsSync throw; the snapshot must not 500.
  process.env.ALLOWED_REPO_PATHS = path.join(dataDir, 'does-not-exist')
  const { db } = await import('../db/schema.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const res = await fetch(`http://127.0.0.1:${port}/agent-context`)
    assert.equal(res.status, 200)
    const snapshot = await res.json()
    assert.deepEqual(snapshot.disk, { freeDiskMb: null, diskOk: null })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    if (previousAllowed === undefined) delete process.env.ALLOWED_REPO_PATHS
    else process.env.ALLOWED_REPO_PATHS = previousAllowed
    await rm(dataDir, { recursive: true, force: true })
  }
})
