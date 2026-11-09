import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import express from 'express'
import { CHANGES_PATCH_BYTE_CAP } from '../agent/git-changes.js'

test('HTML and raw patches review the recorded commit independently of the checkout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-view-commit-'))
  const repo = path.join(root, '<repo>&')
  fs.mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args,
  ], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'root.txt'), 'root-only\n')
  git('add', 'root.txt')
  git('commit', '-qm', 'root')
  const rootSha = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'task-A <script>&"\'\n')
  git('add', 'a.txt')
  git('commit', '-qm', 'A')
  const sha = git('rev-parse', 'HEAD')
  const branch = git('symbolic-ref', '--short', 'HEAD')
  process.env.DATA_DIR = path.join(root, 'data')
  process.env.ALLOWED_REPO_PATHS = root
  process.env.MIN_FREE_DISK_MB = '1'
  const { taskChangesViewRouter } = await import('./task-changes-view.js')
  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  const { insertTask } = await import('../db/queries.js')
  const server = express().use('/tasks', taskChangesViewRouter).use('/tasks', tasksRouter)
    .listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/tasks/task`
  const setSha = (value: string | null) => db.prepare('UPDATE tasks SET commit_sha = ? WHERE id = ?').run(value, 'task')
  const patches = async () => {
    const html = await fetch(`${base}/changes/view`)
    const raw = await fetch(`${base}/changes?format=patch`)
    assert.equal(html.status, 200)
    assert.equal(raw.status, 200)
    return { html: await html.text(), raw: await raw.text() }
  }
  try {
    insertTask({ id: 'task', repo, branch, prompt: 'noop', status: 'completed', log: '', createdAt: new Date().toISOString() })
    setSha(sha)
    const checkA = async () => {
      const { html, raw } = await patches()
      assert.match(html, new RegExp(`Recorded commit changes: <code>${sha}</code>`))
      assert.match(html, /task-A &lt;script&gt;&amp;&quot;&#39;/)
      assert.match(html, /Repository: .*&lt;repo&gt;&amp;/)
      assert.match(raw, /\+task-A <script>/)
      for (const output of [html, raw]) assert.doesNotMatch(output, /task-B|root-only|Current tracked changes/)
    }
    fs.writeFileSync(path.join(repo, 'root.txt'), 'task-B\n')
    await checkA()
    git('add', 'root.txt')
    git('commit', '-qm', 'B')
    assert.equal(git('status', '--porcelain'), '')
    await checkA()

    setSha(rootSha)
    const initial = await patches()
    for (const output of [initial.html, initial.raw]) {
      assert.match(output, /\+root-only/)
      assert.doesNotMatch(output, /task-A|task-B/)
    }

    setSha(null)
    assert.match((await patches()).html, /Current tracked changes in the task checkout/)
    assert.match((await patches()).html, /No tracked changes/)
    fs.writeFileSync(path.join(repo, 'root.txt'), 'fallback-only\n')
    const fallback = await patches()
    for (const output of [fallback.html, fallback.raw]) assert.match(output, /\+fallback-only/)

    // Recorded commits retain the existing byte cap and warning.
    fs.writeFileSync(path.join(repo, 'large.txt'), 'x'.repeat(CHANGES_PATCH_BYTE_CAP + 1000))
    git('add', 'large.txt')
    git('commit', '-qm', 'large')
    setSha(git('rev-parse', 'HEAD'))
    const capped = await fetch(`${base}/changes/view`)
    assert.equal(capped.headers.get('x-patch-truncated'), 'true')
    assert.match(await capped.text(), /Patch truncated/)

    // Malformed stored revisions must fail closed without reflecting their content.
    for (const hostile of ['<img src=x onerror=alert(1)>', '--output=/tmp/forge-hostile', '', 'f'.repeat(40)]) {
      setSha(hostile)
      const failed = await fetch(`${base}/changes/view`)
      assert.equal(failed.status, 503)
      assert.deepEqual(await failed.json(), { error: 'could not inspect repository changes' })
    }
    const missing = await fetch(`${base}-missing/changes/view`)
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), { error: 'task not found' })
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
