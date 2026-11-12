import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import express from 'express'

test('review provenance distinguishes checkout snapshots from recorded commits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-provenance-'))
  const repo = path.join(root, '<repo>&')
  fs.mkdirSync(repo)
  const git = (...args: string[]) => childProcess.execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args,
  ], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q', '-b', 'task-branch')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'recorded content\n')
  git('add', 'tracked.txt')
  git('commit', '-qm', 'initial')
  const sha = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'later content\n')
  process.env.DATA_DIR = path.join(root, 'data')
  process.env.ALLOWED_REPO_PATHS = root
  const { taskChangesViewRouter } = await import('./task-changes-view.js')
  const { db } = await import('../db/schema.js')
  const { insertTask } = await import('../db/queries.js')
  const id = '\"><svg/onload=alert(1)>?&#'
  insertTask({ id, repo, branch: 'task-branch', prompt: 'noop', status: 'completed',
    log: '', createdAt: new Date().toISOString() })
  const server = express().use('/tasks', taskChangesViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const { port } = server.address() as import('node:net').AddressInfo
  const review = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/tasks/${encodeURIComponent(id)}/changes/view`)
    assert.equal(response.status, 200)
    return response.text()
  }
  const originalExec = childProcess.execFileSync
  try {
    const matching = await review()
    assert.match(matching, /Recorded task branch: <code>task-branch<\/code>/)
    assert.match(matching, /Current checkout branch: <code>task-branch<\/code>/)
    assert.match(matching, /current snapshot, not preserved task output/)
    assert.doesNotMatch(matching, /Warning:/)
    assert.ok(matching.includes(`href="/tasks/${encodeURIComponent(id).replace(/&/g, '&amp;').replace(/'/g, '&#39;')}/log/view"`))
    assert.doesNotMatch(matching, /<svg|<repo>/)
    assert.match(matching, /&lt;repo&gt;&amp;/)

    git('checkout', '-qb', 'later-branch')
    const switched = await review()
    assert.match(switched, /Current checkout branch: <code>later-branch<\/code>/)
    assert.match(switched, /class="warning" role="status">Warning: checkout branch differs/)
    git('checkout', '--detach', '-q')
    assert.match(await review(), /unavailable \(detached HEAD\)/)
    assert.match(await review(), /Warning: current checkout branch is unavailable/)

    // Fail only the branch probe: patch/footprint inspection still succeeds.
    childProcess.execFileSync = ((file: string, args: string[], ...rest: unknown[]) => {
      if (args[0] === 'rev-parse' && args[2] === 'HEAD^{commit}') throw new Error('private probe stderr')
      return (originalExec as Function)(file, args, ...rest)
    }) as typeof originalExec
    syncBuiltinESMExports()
    const failed = await review()
    assert.match(failed, /Current checkout branch: <code>unavailable<\/code>/)
    assert.match(failed, /Warning: current checkout branch is unavailable/)
    assert.doesNotMatch(failed, /private probe stderr/)

    db.prepare('UPDATE tasks SET commit_sha = ? WHERE id = ?').run(sha, id)
    const recorded = await review()
    assert.ok(recorded.includes(`Recorded commit changes: <code>${sha}</code>`))
    assert.match(recorded, /\+recorded content/)
    assert.doesNotMatch(recorded, /later content|Current checkout branch|Warning:|current snapshot/)

    childProcess.execFileSync = originalExec
    syncBuiltinESMExports()
    git('checkout', '-q', 'later-branch')
    git('branch', '-m', 'hostile<&"branch')
    db.prepare('UPDATE tasks SET commit_sha = NULL, branch = ? WHERE id = ?').run('<img src=x>&"\'', id)
    const hostile = await review()
    assert.match(hostile, /hostile&lt;&amp;&quot;branch/)
    assert.match(hostile, /&lt;img src=x&gt;&amp;&quot;&#39;/)
    assert.doesNotMatch(hostile, /<img|<svg/)
    assert.match(hostile, /Task outcome/)
    assert.match(hostile, /Recorded task status: <strong>completed/)

    // Invalid checkout HEAD must still fail closed during patch inspection.
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'invalid HEAD\n')
    const invalidHead = await fetch(`http://127.0.0.1:${port}/tasks/${encodeURIComponent(id)}/changes/view`)
    assert.equal(invalidHead.status, 503)
    assert.match(await invalidHead.text(), /Changes temporarily unavailable/)
  } finally {
    childProcess.execFileSync = originalExec
    syncBuiltinESMExports()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
