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

test('action routes exclude stored transcripts and preserve retry inputs', async () => {
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
    inspect = true
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks/${id}/retry`, { method: 'POST' })
    return { status: response.status, body: (await response.json()) as { taskId?: string; error?: string } }
  }

  const originalPrepare = db.prepare
  const selects: string[] = []
  let inspect = false
  db.prepare = function (sql: string) {
    // Dispatch's INSERT ends the request read phase. The runner has its own
    // lifecycle reads after dispatch, outside this route's projection contract.
    if (/^\s*INSERT INTO tasks/i.test(sql)) inspect = false
    if (inspect && /^\s*SELECT\b/i.test(sql)) {
      selects.push(sql)
      assert.doesNotMatch(sql, /SELECT\s+\*|\blog\b|\blog_tail\b/i)
    }
    return originalPrepare.call(this, sql)
  } as typeof db.prepare
  const largeLog = 'transcript'.repeat(400_000)
  try {
    // Unknown id → 404 with an error, no task created.
    const missing = await retry('does-not-exist')
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: 'task not found' })
    assert.match(selects[0], /SELECT repo, prompt, provider, model, auto_commit AS autoCommit, status/)
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 0)

    // A still-active (running) task is not retryable → 409, no dispatch.
    insertTask({
      id: 'active-src', repo: fs.realpathSync(repoB), branch: checkoutBranch, prompt: 'active work',
      status: 'running', log: largeLog, createdAt: new Date().toISOString(),
    })
    const active = await retry('active-src')
    assert.equal(active.status, 409)
    assert.deepEqual(active.body, { error: 'task is not in a terminal state' })
    assert.equal(procs.length, 0)
    db.prepare("UPDATE tasks SET status = 'queued' WHERE id = 'active-src'").run()
    assert.deepEqual(await retry('active-src'), { status: 409, body: { error: 'task is not in a terminal state' } })

    // A failed task re-dispatches as a brand-new task reusing its stored inputs.
    const source = {
      id: 'failed-src', provider: 'claude' as const, autoCommit: true, model: 'claude-haiku-4-5',
      repo: fs.realpathSync(repoA), branch: checkoutBranch, prompt: 'original 😀 prompt\n'.repeat(20_000) + 'END',
      status: 'failed' as const, log: largeLog, createdAt: new Date().toISOString(),
    }
    insertTask(source)
    // An empty recorded commit must stay empty even with later checkout edits.
    const commit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoA, encoding: 'utf8' }).trim()
    db.prepare('UPDATE tasks SET commit_sha = ? WHERE id = ?').run(commit, source.id)
    fs.writeFileSync(path.join(repoA, 'later.txt'), 'later work')
    for (const suffix of ['changes', 'changes?format=patch']) {
      selects.length = 0
      inspect = true
      const response = await fetch(`http://127.0.0.1:${address.port}/tasks/failed-src/${suffix}`)
      assert.equal(response.status, 200)
      if (suffix.includes('?')) assert.equal(await response.text(), '')
      else assert.deepEqual((await response.json() as { changedFiles: unknown[] }).changedFiles, [])
      assert.equal(selects.length, 1)
      assert.match(selects[0], /SELECT id, repo, branch, commit_sha AS commitSha FROM tasks/)
      assert.doesNotMatch(selects[0], /prompt/i)
    }
    inspect = true
    const absent = await fetch(`http://127.0.0.1:${address.port}/tasks/missing/changes`)
    assert.equal(absent.status, 404)
    assert.deepEqual(await absent.json(), { error: 'task not found' })
    insertTask({ ...source, id: 'bad-repo', repo: path.join(root, 'missing') })
    for (const suffix of ['changes', 'changes?format=patch']) {
      inspect = true
      const response = await fetch(`http://127.0.0.1:${address.port}/tasks/bad-repo/${suffix}`)
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { error: 'could not inspect repository changes' })
    }
    const retried = await retry('failed-src')
    assert.equal(retried.status, 201)
    assert.ok(retried.body.taskId)
    assert.notEqual(retried.body.taskId, 'failed-src')
    await new Promise(resolve => setImmediate(resolve))

    db.prepare = originalPrepare
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
    db.prepare = originalPrepare
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
