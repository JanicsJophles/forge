import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import express from 'express'

test('task admission checks checkout and actual SQLite volumes independently', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-data-disk-'))
  const repo = path.join(root, 'repo')
  const data = path.join(root, 'sqlite-volume')
  fs.mkdirSync(data)
  childProcess.execFileSync('git', ['init', '-q', '-b', 'main', repo])
  fs.mkdirSync(path.join(repo, 'nested'))
  // DATA_DIR is an alias; readings must use the actual database parent.
  fs.symlinkSync(data, path.join(root, 'data-alias'))
  process.env.DOTENV_CONFIG_PATH = path.join(root, 'no-env-file')
  process.env.DATA_DIR = path.join(root, 'data-alias')
  process.env.ALLOWED_REPO_PATHS = root
  process.env.MIN_FREE_DISK_MB = '100'
  process.env.CODEX_RUN_USER = 'fake'
  const originalStatfs = fs.statfsSync
  const originalSpawn = childProcess.spawn
  const originalExecFile = childProcess.execFileSync
  const probes: EventEmitter[] = []
  const readings: string[] = []
  let repoMb: number | null = 200
  let dataMb: number | null = 200
  fs.statfsSync = ((directory: string) => {
    readings.push(directory)
    assert.ok(directory === repo || directory === data, `unexpected path ${directory}`)
    const mb = directory === repo ? repoMb : dataMb
    if (mb === null) throw new Error('injected stat failure')
    return { bavail: mb, bsize: 1024 * 1024 }
  }) as typeof fs.statfsSync
  childProcess.execFileSync = ((file: string, args: string[], options: object) => file === 'git'
    ? originalExecFile(file, args, options)
    : 'fake:x:1234:1234::/tmp:/bin/sh') as typeof childProcess.execFileSync
  childProcess.spawn = (() => {
    const probe = new EventEmitter()
    Object.assign(probe, { kill: () => true })
    probes.push(probe)
    return probe
  }) as typeof childProcess.spawn
  syncBuiltinESMExports()
  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  const { getEmitter } = await import('../agent/stream.js')
  const server = express().use(express.json()).use('/tasks', tasksRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as import('node:net').AddressInfo
  try {
    for (const [repoReading, dataReading, volume] of [
      [99, 200, 'repo'], [200, 99, 'data'],
      [null, 99, 'data'], [99, null, 'repo'],
      [200, 200, null], [100, 100, null],
      [null, 200, null], [200, null, null], [null, null, null],
    ] as const) {
      repoMb = repoReading
      dataMb = dataReading
      readings.length = 0
      const previousProbes = probes.length
      const response = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: path.join(repo, 'nested'), prompt: 'test', branch: 'main', provider: 'codex' }),
      })
      const body = await response.json() as { taskId: string }
      if (volume) {
        assert.equal(response.status, 507)
        assert.deepEqual(body, { error: 'insufficient disk space to accept new tasks', volume, freeMb: 99, requiredMb: 100 })
        assert.equal(probes.length, previousProbes)
        assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 0)
        assert.equal(getEmitter(body.taskId), undefined)
      } else {
        assert.equal(response.status, 201)
        assert.deepEqual(readings, [repo, data])
        assert.equal(probes.length, previousProbes + 1)
        assert.ok(getEmitter(body.taskId))
        probes.at(-1)!.emit('close', 1)
        await new Promise(resolve => setImmediate(resolve))
        db.prepare('DELETE FROM tasks').run()
      }
    }
  } finally {
    for (const probe of probes) probe.emit('close', 1)
    await new Promise(resolve => setImmediate(resolve))
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    fs.statfsSync = originalStatfs
    childProcess.spawn = originalSpawn
    childProcess.execFileSync = originalExecFile
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
