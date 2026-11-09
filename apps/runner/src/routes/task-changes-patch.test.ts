import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import express from 'express'
import { CHANGES_PATCH_BYTE_CAP } from '../agent/git-changes.js'

test('GET /tasks/:id/changes?format=patch returns the bounded tracked diff and validates format', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-changes-patch-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  childProcess.execFileSync('git', ['init', '-q', repo])
  const git = (...args: string[]) =>
    childProcess.execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
      { cwd: repo, stdio: 'pipe' },
    )
  // Commit a tracked file, then modify it so the diff has concrete content.
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original\n')
  git('add', 'tracked.txt')
  git('commit', '-qm', 'init')
  const branch = childProcess
    .execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' })
    .trim()
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n')

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
    insertTask({
      id: 'task-under-test',
      repo,
      branch,
      prompt: 'noop',
      status: 'completed',
      log: '',
      createdAt: new Date().toISOString(),
    })

    // Unknown id -> 404, same shape as the default path.
    const missing = await fetch(`${base}/tasks/does-not-exist/changes?format=patch`)
    assert.equal(missing.status, 404)
    assert.equal(((await missing.json()) as { error: string }).error, 'task not found')

    // format=patch -> text/plain unified diff with the untruncated header.
    const patch = await fetch(`${base}/tasks/task-under-test/changes?format=patch`)
    assert.equal(patch.status, 200)
    assert.match(patch.headers.get('content-type') ?? '', /text\/plain/)
    assert.equal(patch.headers.get('x-patch-truncated'), 'false')
    const diff = await patch.text()
    assert.match(diff, /diff --git a\/tracked\.txt b\/tracked\.txt/)
    assert.match(diff, /-original/)
    assert.match(diff, /\+changed/)

    // The default (no format) JSON response is unchanged.
    const json = await fetch(`${base}/tasks/task-under-test/changes`)
    assert.equal(json.status, 200)
    assert.match(json.headers.get('content-type') ?? '', /application\/json/)
    const body = (await json.json()) as { changedFiles: { path: string; status: string }[] }
    assert.equal(body.changedFiles[0].path, 'tracked.txt')
    assert.equal(body.changedFiles[0].status, 'M')

    // Bad format values (unknown, empty, repeated, structured) -> 400, never the diff.
    for (const bad of ['?format=json', '?format=', '?format=PATCH', '?format=patch&format=patch', '?format[]=patch']) {
      const rejected = await fetch(`${base}/tasks/task-under-test/changes${bad}`)
      assert.equal(rejected.status, 400, `expected 400 for ${bad}`)
      assert.equal(((await rejected.json()) as { error: string }).error, "format must be omitted or 'patch'")
    }

    // A diff larger than the byte cap -> body capped at exactly the cap, header true.
    // ASCII content keeps bytes == chars so the slice lands on a clean boundary.
    const big = 'x'.repeat(CHANGES_PATCH_BYTE_CAP + 50_000) + '\n'
    fs.writeFileSync(path.join(repo, 'tracked.txt'), big)
    const capped = await fetch(`${base}/tasks/task-under-test/changes?format=patch`)
    assert.equal(capped.status, 200)
    assert.equal(capped.headers.get('x-patch-truncated'), 'true')
    const cappedText = await capped.text()
    assert.equal(Buffer.byteLength(cappedText, 'utf8'), CHANGES_PATCH_BYTE_CAP)

    // Git failure (checkout removed) on the patch path -> static 503, never raw git output.
    fs.rmSync(repo, { recursive: true, force: true })
    const failed = await fetch(`${base}/tasks/task-under-test/changes?format=patch`)
    assert.equal(failed.status, 503)
    assert.equal(((await failed.json()) as { error: string }).error, 'could not inspect repository changes')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
