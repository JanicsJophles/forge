import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import express from 'express'
import Database from 'better-sqlite3'

test('canonical checkout admission reserves queued probes and releases terminal tasks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-admission-'))
  const repo = path.join(root, 'repo')
  const other = path.join(root, 'other')
  for (const dir of [repo, other]) {
    fs.mkdirSync(dir)
    childProcess.execFileSync('git', ['init', '-q', '-b', 'main', dir])
  }
  fs.symlinkSync(repo, path.join(root, 'alias'))
  fs.writeFileSync(path.join(root, 'file'), '')
  process.env.DATA_DIR = path.join(root, 'data')
  process.env.ALLOWED_REPO_PATHS = root
  process.env.MAX_CONCURRENT_TASKS = '10'
  process.env.MIN_FREE_DISK_MB = '0'
  process.env.CODEX_RUN_USER = 'fake'
  const probes: EventEmitter[] = []
  let gitCalls = 0
  const originalSpawn = childProcess.spawn
  const originalExec = childProcess.execSync
  const originalExecFile = childProcess.execFileSync
  let peer: Database.Database | undefined
  let checkedWriterFence = false
  // Fake provider login stays pending until explicitly failed. Only Git
  // discovery runs real child processes, against these temporary repositories.
  childProcess.execFileSync = ((file: string, args: string[], options: object) => {
    if (peer && db.inTransaction && !checkedWriterFence) {
      // A second SQLite writer cannot race admission between its read and INSERT.
      assert.throws(() => peer!.prepare('UPDATE tasks SET log = log').run(), /locked/)
      checkedWriterFence = true
    }
    return file === 'git' ? originalExecFile(file, args, options) : 'fake:x:1234:1234::/tmp:/bin/sh'
  }) as typeof childProcess.execFileSync
  childProcess.execSync = (() => { gitCalls++; return '' }) as typeof childProcess.execSync
  childProcess.spawn = (() => {
    assert.equal(db.inTransaction, false, 'provider processes start only after the reservation commits')
    const probe = new EventEmitter()
    Object.assign(probe, { kill: () => true })
    probes.push(probe)
    return probe
  }) as typeof childProcess.spawn
  syncBuiltinESMExports()
  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  peer = new Database(db.name, { timeout: 0 })
  const { getTask, insertTask, updateTaskStatus } = await import('../db/queries.js')
  const { getEmitter } = await import('../agent/stream.js')
  const app = express().use(express.json()).use('/tasks', tasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as import('node:net').AddressInfo
  async function post(candidate: string, provider = 'codex') {
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: candidate, prompt: 'test', branch: 'main', provider }),
    })
    return { status: response.status, body: await response.json() as { taskId: string; code?: string; accepted?: boolean; retryable?: boolean } }
  }
  try {
    for (const invalid of [path.join(root, 'missing'), path.join(root, 'file')]) {
      assert.equal((await post(invalid)).status, 400)
    }
    assert.equal(probes.length, 0)
    const raced = await Promise.all([post(repo), post(repo, 'claude')])
    assert.deepEqual(raced.map(r => r.status).sort(), [201, 409])
    const first = raced.find(r => r.status === 201)!
    const refused = raced.find(r => r.status === 409)!
    assert.equal(refused.body.code, 'FORGE_CHECKOUT_BUSY')
    assert.equal(refused.body.accepted, false)
    assert.equal(refused.body.retryable, true)
    assert.equal(first.status, 201)
    assert.equal(getTask(first.body.taskId)?.status, 'queued')
    assert.ok(getEmitter(first.body.taskId))
    for (const alias of [repo, path.join(root, 'alias'), path.relative(process.cwd(), repo), `${other}/../repo`]) {
      const blocked = await post(alias)
      assert.equal(blocked.status, 409)
      assert.equal(blocked.body.taskId, first.body.taskId)
    }
    assert.equal(probes.length, 1)
    assert.equal(gitCalls, 0)
    assert.equal(checkedWriterFence, true)
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 1)
    updateTaskStatus(first.body.taskId, 'running')
    assert.equal((await post(repo)).status, 409)
    assert.equal((await post(other)).status, 201)
    probes[0].emit('close', 1)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(getTask(first.body.taskId)?.status, 'failed')
    assert.equal(getEmitter(first.body.taskId), undefined)
    const retry = await post(path.join(root, 'alias'))
    assert.equal(retry.status, 201)
    assert.equal(getTask(retry.body.taskId)?.repo, fs.realpathSync(repo))
    // Legacy rows may store aliases rather than the canonical path.
    updateTaskStatus(retry.body.taskId, 'completed')
    insertTask({ id: 'legacy', repo: path.join(root, 'alias'), branch: 'main', prompt: 'old', status: 'running', log: '', createdAt: new Date().toISOString() })
    assert.equal((await post(repo)).body.taskId, 'legacy')
    assert.equal(gitCalls, 0)
  } finally {
    for (const probe of probes) probe.emit('close', 1)
    await new Promise(resolve => setImmediate(resolve))
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    peer.close(); db.close()
    childProcess.spawn = originalSpawn
    childProcess.execSync = originalExec
    childProcess.execFileSync = originalExecFile
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
