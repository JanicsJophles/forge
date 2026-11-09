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

test('POST /tasks/:id/retry re-dispatches terminal tasks and guards active/missing ones', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-retry-'))
  const repoA = path.join(root, 'repoA')
  const repoB = path.join(root, 'repoB')
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
  process.env.ALLOWED_REPO_PATHS = root
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
    // Unknown id → 404 with an error, no task created.
    const missing = await retry('does-not-exist')
    assert.equal(missing.status, 404)
    assert.ok(missing.body.error)
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 0)

    // A still-active (running) task is not retryable → 409, no dispatch.
    insertTask({
      id: 'active-src', repo: fs.realpathSync(repoB), branch: checkoutBranch, prompt: 'active work',
      status: 'running', log: '', createdAt: new Date().toISOString(),
    })
    const active = await retry('active-src')
    assert.equal(active.status, 409)
    assert.ok(active.body.error)
    assert.equal(procs.length, 0)

    // A failed task re-dispatches as a brand-new task reusing its stored inputs.
    const source = {
      id: 'failed-src', provider: 'claude' as const, autoCommit: true, model: 'claude-haiku-4-5',
      repo: fs.realpathSync(repoA), branch: checkoutBranch, prompt: 'the original prompt',
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
    assert.equal(created!.repo, source.repo)
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
