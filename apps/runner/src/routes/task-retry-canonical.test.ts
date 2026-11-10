import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import express from 'express'

interface FakeProc extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: EventEmitter & { end: (...a: unknown[]) => void }
  kill: () => boolean
}

test('retry recanonicalizes stored directories before admission and dispatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-retry-'))
  const allowed = path.join(root, 'allowed')
  fs.mkdirSync(allowed)
  const repoA = path.join(allowed, 'repoA')
  const repoB = path.join(allowed, 'repoB')
  for (const dir of [repoA, repoB]) {
    fs.mkdirSync(dir)
    childProcess.execFileSync('git', ['init', '-q', dir])
    childProcess.execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'init'],
      { cwd: dir },
    )
  }
  const checkoutBranch = childProcess
    .execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoA, encoding: 'utf8' })
    .trim()

  process.env.DATA_DIR = path.join(root, 'data')
  process.env.ALLOWED_REPO_PATHS = allowed
  process.env.MAX_CONCURRENT_TASKS = '10'
  process.env.MIN_FREE_DISK_MB = '1'
  // Run the agent as the current (non-root) account so executionIdentity needs
  // no getent lookup; only Git discovery runs real child processes.
  process.env.CLAUDE_RUN_USER = os.userInfo().username

  const procs: FakeProc[] = []
  const originalSpawn = childProcess.spawn
  childProcess.spawn = (() => {
    const proc = new EventEmitter() as FakeProc
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    const stdin = new EventEmitter() as FakeProc['stdin']
    stdin.end = () => {}
    proc.stdin = stdin
    proc.kill = () => true
    procs.push(proc)
    return proc
  }) as typeof childProcess.spawn
  syncBuiltinESMExports()

  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  const { insertTask, getTask } = await import('../db/queries.js')
  const app = express().use(express.json()).use('/tasks', tasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as import('node:net').AddressInfo
  async function retry(id: string) {
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks/${id}/retry`, { method: 'POST' })
    return { status: response.status, body: (await response.json()) as { taskId?: string; error?: string } }
  }

  try {
    const seed = (id: string, repo: string, status: 'running' | 'failed' = 'failed') => {
      insertTask({ id, repo, branch: 'historical-branch', prompt: 'retry prompt',
        status, log: '', createdAt: new Date().toISOString() })
    }
    const count = () => (db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n
    const rejected = async (id: string, status: number, error: string) => {
      const before = count()
      const response = await retry(id)
      assert.equal(response.status, status)
      assert.equal(response.body.error, error)
      assert.equal(count(), before, 'rejection must not insert a task')
      assert.equal(procs.length, 0, 'rejection must not launch a provider')
    }

    seed('active', repoB, 'running')
    const alias = path.join(allowed, 'alias')
    // Model a valid stored directory replaced with a symlink after its run.
    fs.mkdirSync(alias)
    seed('redirected-active', alias)
    fs.rmdirSync(alias)
    fs.symlinkSync(repoB, alias)
    await rejected('redirected-active', 409, 'repo checkout already has an active task')

    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    childProcess.execFileSync('git', ['init', '-q', outside])
    fs.unlinkSync(alias)
    fs.symlinkSync(outside, alias)
    await rejected('redirected-active', 400, 'repo path is not in ALLOWED_REPO_PATHS')

    const removed = path.join(allowed, 'removed')
    fs.mkdirSync(removed)
    seed('removed', removed)
    fs.rmdirSync(removed)
    await rejected('removed', 400, 'repo path is not in ALLOWED_REPO_PATHS')

    const plain = path.join(allowed, 'plain')
    fs.mkdirSync(plain)
    seed('not-git', plain)
    await rejected('not-git', 400, 'repo must be inside a Git checkout with a discoverable root')
    const file = path.join(allowed, 'file')
    fs.writeFileSync(file, '')
    seed('file', file)
    await rejected('file', 400, 'repo must be an existing directory')

    // The path is allowed, but its discovered checkout root is not.
    const nested = path.join(outside, 'nested')
    fs.mkdirSync(nested)
    fs.unlinkSync(alias)
    fs.symlinkSync(nested, alias)
    // Add only the resolved subdirectory to the allowlist, never its root.
    const { config } = await import('../config.js')
    config.allowedRepoPaths.push(nested)
    await rejected('redirected-active', 400, 'repo checkout root is not in ALLOWED_REPO_PATHS')

    const subdir = path.join(repoA, 'legacy', 'subdirectory')
    fs.mkdirSync(subdir, { recursive: true })
    // A failed task re-dispatches as a brand-new task reusing its stored inputs.
    const source = {
      id: 'failed-src', provider: 'claude' as const, autoCommit: true, model: 'claude-haiku-4-5',
      repo: subdir, branch: 'historical-branch', prompt: 'the original prompt',
      status: 'failed' as const, log: '', createdAt: new Date().toISOString(),
    }
    insertTask(source)
    const retried = await retry('failed-src')
    assert.equal(retried.status, 201)
    assert.ok(retried.body.taskId)
    assert.notEqual(retried.body.taskId, 'failed-src')
    await new Promise(resolve => setImmediate(resolve))

    const created = getTask(retried.body.taskId!)
    assert.ok(created)
    assert.ok(created!.status === 'queued' || created!.status === 'running')
    assert.equal(created!.repo, fs.realpathSync(repoA))
    assert.equal(created!.prompt, source.prompt)
    assert.equal(created!.provider, 'claude')
    assert.equal(created!.model, 'claude-haiku-4-5')
    assert.equal(created!.autoCommit, true)
    assert.equal(created!.branch, checkoutBranch)
    assert.equal(procs.length, 1)
  } finally {
    for (const proc of procs) proc.emit('close', 0, null)
    await new Promise(resolve => setImmediate(resolve))
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
