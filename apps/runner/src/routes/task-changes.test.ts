import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import express from 'express'

test('GET /tasks/:id/changes reports a task checkout footprint and hides git failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-changes-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  childProcess.execFileSync('git', ['init', '-q', repo])
  const git = (...args: string[]) =>
    childProcess.execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
      { cwd: repo, stdio: 'pipe' },
    )
  // Commit a file, then produce one tracked modification and one untracked file.
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original\n')
  git('add', 'tracked.txt')
  git('commit', '-qm', 'init')
  const branch = childProcess
    .execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' })
    .trim()
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n')
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n')

  process.env.DATA_DIR = path.join(root, 'data')
  process.env.ALLOWED_REPO_PATHS = root
  process.env.MAX_CONCURRENT_TASKS = '10'
  process.env.MIN_FREE_DISK_MB = '1'

  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  const { insertTask } = await import('../db/queries.js')
  const app = express().use(express.json()).use('/tasks', tasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as import('node:net').AddressInfo
  const base = `http://127.0.0.1:${address.port}`

  try {
    // Unknown id -> 404 with the standard task-not-found shape.
    const missing = await fetch(`${base}/tasks/does-not-exist/changes`)
    assert.equal(missing.status, 404)
    assert.equal(((await missing.json()) as { error: string }).error, 'task not found')

    insertTask({
      id: 'task-under-test',
      repo,
      branch,
      prompt: 'noop',
      status: 'completed',
      log: '',
      createdAt: new Date().toISOString(),
    })

    // Known task -> both the modified and the untracked file, correctly labelled.
    const ok = await fetch(`${base}/tasks/task-under-test/changes`)
    assert.equal(ok.status, 200)
    const payload = (await ok.json()) as {
      taskId: string
      repo: string
      branch: string
      changedFiles: { path: string; status: string }[]
    }
    assert.equal(payload.taskId, 'task-under-test')
    assert.equal(payload.repo, repo)
    assert.equal(payload.branch, branch)
    const byPath = new Map(payload.changedFiles.map(entry => [entry.path, entry.status]))
    assert.equal(byPath.get('tracked.txt'), 'M')
    assert.equal(byPath.get('untracked.txt'), '?')
    assert.equal(payload.changedFiles.length, 2)

    // Git failure (checkout removed) -> static 503 JSON, never raw git output.
    fs.rmSync(repo, { recursive: true, force: true })
    const failed = await fetch(`${base}/tasks/task-under-test/changes`)
    assert.equal(failed.status, 503)
    const failBody = (await failed.json()) as { error: string }
    assert.equal(failBody.error, 'could not inspect repository changes')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
