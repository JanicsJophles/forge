import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import express from 'express'

test('checkout roots lock subdirectories and legacy aliases but isolate worktrees and clones', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-checkout-root-'))
  const repo = path.join(root, 'repo')
  const other = path.join(root, 'other')
  for (const dir of [repo, other]) {
    fs.mkdirSync(dir)
    childProcess.execFileSync('git', ['init', '-q', dir])
  }
  fs.mkdirSync(path.join(repo, 'src'))
  const git = (...args: string[]) => childProcess.execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'init')
  const worktree = path.join(root, 'worktree')
  git('worktree', 'add', '-qb', 'linked', worktree)
  const clone = path.join(root, 'clone')
  git('clone', '-q', repo, clone)
  const nonrepo = path.join(root, 'nonrepo')
  fs.mkdirSync(nonrepo)
  const bare = path.join(root, 'bare')
  git('init', '--bare', '-q', bare)
  fs.symlinkSync(path.join(repo, 'src'), path.join(root, 'alias'))
  fs.writeFileSync(path.join(root, 'file'), '')
  process.env.DATA_DIR = path.join(root, 'data')
  process.env.ALLOWED_REPO_PATHS = root
  process.env.MAX_CONCURRENT_TASKS = '10'
  process.env.MIN_FREE_DISK_MB = '1'
  process.env.CODEX_RUN_USER = 'fake'
  const probes: EventEmitter[] = []
  let gitCalls = 0
  const originalSpawn = childProcess.spawn
  const originalExec = childProcess.execSync
  const originalExecFile = childProcess.execFileSync
  // Fake provider login stays pending until explicitly failed. Only Git
  // discovery runs real child processes, against these temporary repositories.
  childProcess.execFileSync = ((file: string, args: string[], options: object) => file === 'git'
    ? originalExecFile(file, args, options)
    : 'fake:x:1234:1234::/tmp:/bin/sh') as typeof childProcess.execFileSync
  childProcess.execSync = (() => { gitCalls++; return '' }) as typeof childProcess.execSync
  childProcess.spawn = (() => {
    const probe = new EventEmitter()
    Object.assign(probe, { kill: () => true })
    probes.push(probe)
    return probe
  }) as typeof childProcess.spawn
  syncBuiltinESMExports()
  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  const { getTask, insertTask, updateTaskStatus } = await import('../db/queries.js')
  const { getEmitter } = await import('../agent/stream.js')
  const app = express().use(express.json()).use('/tasks', tasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as import('node:net').AddressInfo
  async function post(candidate: string) {
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: candidate, prompt: 'test', branch: 'main', provider: 'codex' }),
    })
    return { status: response.status, body: await response.json() as { taskId: string } }
  }
  try {
    for (const invalid of [path.join(root, 'missing'), path.join(root, 'file'), nonrepo, bare]) {
      assert.equal((await post(invalid)).status, 400)
    }
    assert.equal(probes.length, 0)
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 0)
    const first = await post(path.join(repo, 'src'))
    assert.equal(first.status, 201)
    assert.equal(getTask(first.body.taskId)?.status, 'queued')
    assert.equal(getTask(first.body.taskId)?.repo, fs.realpathSync(repo))
    assert.ok(getEmitter(first.body.taskId))
    for (const alias of [repo, path.join(repo, 'src'), path.join(root, 'alias'), path.relative(process.cwd(), repo), `${other}/../repo`]) {
      const blocked = await post(alias)
      assert.equal(blocked.status, 409)
      assert.equal(blocked.body.taskId, first.body.taskId)
    }
    assert.equal(probes.length, 1)
    assert.equal(gitCalls, 0)
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 1)
    updateTaskStatus(first.body.taskId, 'running')
    assert.equal((await post(repo)).status, 409)
    for (const independent of [other, worktree, clone]) {
      const admitted = await post(independent)
      assert.equal(admitted.status, 201)
      assert.equal(getTask(admitted.body.taskId)?.repo, fs.realpathSync(independent))
    }
    probes[0].emit('close', 1)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(getTask(first.body.taskId)?.status, 'failed')
    assert.equal(getEmitter(first.body.taskId), undefined)
    const retry = await post(path.join(root, 'alias'))
    assert.equal(retry.status, 201)
    assert.equal(getTask(retry.body.taskId)?.repo, fs.realpathSync(repo))
    // Legacy rows may store aliases rather than the canonical path.
    updateTaskStatus(retry.body.taskId, 'completed')
    for (const [index, legacyRepo] of [path.join(repo, 'src'), path.join(root, 'alias')].entries()) {
      const id = `legacy-${index}`
      insertTask({ id, repo: legacyRepo, branch: 'main', prompt: 'old', status: 'running', log: '', createdAt: new Date().toISOString() })
      const rows = (db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n
      const probeCount = probes.length
      for (const candidate of [repo, path.join(repo, 'src'), path.join(root, 'alias')]) {
        const blocked = await post(candidate)
        assert.equal(blocked.status, 409)
        assert.equal(blocked.body.taskId, id)
      }
      assert.equal(probes.length, probeCount)
      assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, rows)
      assert.equal(getEmitter(id), undefined)
      updateTaskStatus(id, 'completed')
    }
    assert.equal(gitCalls, 0)
  } finally {
    for (const probe of probes) probe.emit('close', 1)
    await new Promise(resolve => setImmediate(resolve))
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    childProcess.spawn = originalSpawn
    childProcess.execSync = originalExec
    childProcess.execFileSync = originalExecFile
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
