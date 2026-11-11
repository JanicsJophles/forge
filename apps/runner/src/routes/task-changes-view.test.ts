import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import express from 'express'
import { CHANGES_PATCH_BYTE_CAP } from '../agent/git-changes.js'

test('HTML changes viewer escapes patches, bounds output and handles missing tasks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-changes-patch-'))
  const repo = path.join(root, '<repo>&')
  fs.mkdirSync(repo)
  childProcess.execFileSync('git', ['init', '-q', repo])
  const git = (...args: string[]) =>
    childProcess.execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
      { cwd: repo, stdio: 'pipe' },
    )
  // Commit a tracked file, then modify it so the diff has concrete content.
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original <script>&\n')
  git('add', 'tracked.txt')
  git('commit', '-qm', 'init')
  const branch = childProcess
    .execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' })
    .trim()
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed <img>&\n')

  process.env.DATA_DIR = path.join(root, 'data')
  process.env.ALLOWED_REPO_PATHS = root
  process.env.MAX_CONCURRENT_TASKS = '10'
  process.env.MIN_FREE_DISK_MB = '1'

  const { taskChangesViewRouter } = await import('./task-changes-view.js')
  const { db } = await import('../db/schema.js')
  const { tasksRouter } = await import('./tasks.js')
  const { insertTask } = await import('../db/queries.js')
  const app = express().use(express.json()).use('/tasks', taskChangesViewRouter).use('/tasks', tasksRouter)
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

    // Unknown id keeps browser navigation available.
    const missing = await fetch(`${base}/tasks/does-not-exist/changes/view`)
    assert.equal(missing.status, 404)
    assert.match(await missing.text(), /Task not found/)

    // Known task returns an escaped, color-coded HTML diff.
    const patch = await fetch(`${base}/tasks/task-under-test/changes/view`)
    assert.equal(patch.status, 200)
    assert.match(patch.headers.get('content-type') ?? '', /text\/html/)
    assert.equal(patch.headers.get('x-patch-truncated'), 'false')
    const diff = await patch.text()
    assert.match(diff, /diff --git a\/tracked\.txt b\/tracked\.txt/)
    assert.match(diff, /class="removed">-original &lt;script&gt;&amp;/)
    assert.match(diff, /class="added">\+changed &lt;img&gt;&amp;/)
    assert.doesNotMatch(diff, /<script>|<img>|<repo>/)
    assert.match(diff, /&lt;repo&gt;&amp;/)

    assert.equal((await fetch(`${base}/tasks/task-under-test`)).status, 200)
    assert.match((await fetch(`${base}/tasks/task-under-test/changes`)).headers.get('content-type') ?? '', /application\/json/)
    const hostileId = '"><svg onload=alert(1)>'
    db.prepare('UPDATE tasks SET id = ? WHERE id = ?').run(hostileId, 'task-under-test')
    const hostile = await fetch(`${base}/tasks/${encodeURIComponent(hostileId)}/changes/view`)
    assert.equal(hostile.status, 200)
    const hostileHtml = await hostile.text()
    assert.doesNotMatch(hostileHtml, /<svg/)
    assert.match(hostileHtml, /&quot;&gt;&lt;svg/)
    db.prepare('UPDATE tasks SET id = ? WHERE id = ?').run('task-under-test', hostileId)
    git('checkout', '--', 'tracked.txt')
    assert.match(await (await fetch(`${base}/tasks/task-under-test/changes/view`)).text(), /No tracked changes/)

    // Oversized diffs show a truncation warning and remain bounded.
    // ASCII content keeps bytes == chars so the slice lands on a clean boundary.
    const big = 'x'.repeat(CHANGES_PATCH_BYTE_CAP + 50_000) + '\n'
    fs.writeFileSync(path.join(repo, 'tracked.txt'), big)
    const capped = await fetch(`${base}/tasks/task-under-test/changes/view`)
    assert.equal(capped.status, 200)
    assert.equal(capped.headers.get('x-patch-truncated'), 'true')
    const cappedText = await capped.text()
    assert.match(cappedText, /Patch truncated/)
    assert.ok(cappedText.length < CHANGES_PATCH_BYTE_CAP + 10_000)

    // Git failure (checkout removed) on the patch path -> static 503, never raw git output.
    fs.rmSync(repo, { recursive: true, force: true })
    const failed = await fetch(`${base}/tasks/task-under-test/changes/view`)
    assert.equal(failed.status, 503)
    assert.match(await failed.text(), /Changes temporarily unavailable/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
