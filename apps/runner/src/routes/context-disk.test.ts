import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('/agent-context keeps disk global and tolerates unavailable configured roots', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-context-disk-'))
  const previousDataDir = process.env.DATA_DIR
  const previousPaths = process.env.ALLOWED_REPO_PATHS
  process.env.DATA_DIR = dataDir
  process.env.ALLOWED_REPO_PATHS = dataDir
  const { db } = await import('../db/schema.js')
  const { createAgentContextRouter } = await import('./agent-state.js')
  const { freeDiskBytes } = await import('../agent/disk.js')
  try {
    const missing = path.join(dataDir, 'missing')
    const cases = [
      { paths: ['/global-root', '/other-root'], bytes: 100 * 1048576 + 123, expected: { freeDiskMb: 100, diskOk: true } },
      { paths: ['/global-root'], bytes: 99 * 1048576, expected: { freeDiskMb: 99, diskOk: false } },
      { paths: [missing], probe: freeDiskBytes, expected: { freeDiskMb: null, diskOk: null } },
      { paths: ['/unreadable'], probe: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }, expected: { freeDiskMb: null, diskOk: null } },
      { paths: [], expected: { freeDiskMb: null, diskOk: null } },
    ]
    for (const scenario of cases) {
      const calls: string[] = []
      const router = createAgentContextRouter({
        allowedRepoPaths: scenario.paths,
        databasePath: missing,
        minFreeDiskMb: 100,
        freeDiskBytes: root => {
          calls.push(root)
          return scenario.probe ? scenario.probe(root) : scenario.bytes!
        },
      })
      const server = express().use(router).listen(0, '127.0.0.1')
      try {
        await new Promise<void>(resolve => server.once('listening', resolve))
        const { port } = server.address() as { port: number }
        for (const query of ['', '?repo=alpha']) {
          const response = await fetch(`http://127.0.0.1:${port}/agent-context${query}`)
          assert.equal(response.status, 200)
          assert.deepEqual((await response.json()).disk, { ...scenario.expected, dataFreeDiskMb: null, dataDiskOk: null })
        }
        assert.deepEqual(calls, scenario.paths.length ? [scenario.paths[0], scenario.paths[0]] : [])
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    }
  } finally {
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    if (previousPaths === undefined) delete process.env.ALLOWED_REPO_PATHS
    else process.env.ALLOWED_REPO_PATHS = previousPaths
    await rm(dataDir, { recursive: true, force: true })
  }
})
