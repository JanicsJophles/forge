import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('/agent-context reports independent runner-wide repo and resolved SQLite disk snapshots', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-context-data-disk-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('../db/schema.js')
  const { createAgentContextRouter } = await import('./agent-state.js')
  const dataVolume = path.join(directory, 'data-volume')
  const databasePath = path.join(directory, 'linked.db')
  try {
    await mkdir(dataVolume)
    const target = path.join(dataVolume, 'disposable.db')
    await writeFile(target, '')
    await symlink(target, databasePath)
    const cases = [
      { repo: 200, data: 99 },
      { repo: 99, data: 200 },
      { repo: 100, data: 100 }, // Equality passes for both volumes.
      { repo: null, data: 200 },
      { repo: 200, data: null },
      { repo: null, data: null },
      { repo: 200, data: null, missing: true },
      { repo: 0, data: 0 },
      { repo: NaN, data: Infinity },
      { repo: -1, data: -1 },
    ]
    for (const scenario of cases) {
      const calls: string[] = []
      const router = createAgentContextRouter({
        allowedRepoPaths: ['/repo-volume', '/second-repo'],
        databasePath: scenario.missing ? path.join(directory, 'missing.db') : databasePath,
        minFreeDiskMb: 100,
        freeDiskBytes: root => {
          calls.push(root)
          assert.ok(root === '/repo-volume' || root === dataVolume)
          const mb = root === '/repo-volume' ? scenario.repo : scenario.data
          if (mb === null) throw new Error('private path or credentials must not escape')
          return mb * 1048576 + 123
        },
      })
      const server = express().use(router).listen(0, '127.0.0.1')
      try {
        await new Promise<void>(resolve => server.once('listening', resolve))
        const { port } = server.address() as { port: number }
        const measured = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0 ? value : null
        const repo = measured(scenario.repo)
        const data = measured(scenario.data)
        let capacity: unknown
        for (const query of ['', '?repo=second-repo']) {
          const response = await fetch(`http://127.0.0.1:${port}/agent-context${query}`)
          assert.equal(response.status, 200)
          const body = await response.json()
          assert.deepEqual(body.disk, {
            freeDiskMb: repo, diskOk: repo === null ? null : repo >= 100,
            dataFreeDiskMb: data, dataDiskOk: data === null ? null : data >= 100,
          })
          assert.equal(Object.hasOwn(body, 'acceptingTasks'), false)
          assert.equal(body.recentEventsTruncated, false)
          assert.equal(body.recentEventsOldestId, null)
          if (query === '') capacity = body.capacity
          else assert.deepEqual(body.capacity, capacity)
        }
        assert.deepEqual(calls, scenario.missing
          ? ['/repo-volume', '/repo-volume']
          : ['/repo-volume', dataVolume, '/repo-volume', dataVolume])
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    }
  } finally {
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(directory, { recursive: true, force: true })
  }
})
