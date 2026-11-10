import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import express from 'express'
import { CHANGED_FILES_LIMIT } from '../agent/git-changes.js'

test('HTML footprint names untracked files, bounds lists and isolates recorded commits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-view-footprint-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args,
  ], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'initial\n')
  git('add', 'tracked.txt')
  git('commit', '-qm', 'initial')
  const rootSha = git('rev-parse', 'HEAD')
  process.env.DATA_DIR = path.join(root, 'data')
  const { taskChangesViewRouter } = await import('./task-changes-view.js')
  const { db } = await import('../db/schema.js')
  const { insertTask } = await import('../db/queries.js')
  const server = express().use('/tasks', taskChangesViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/tasks/task/changes/view`
  const html = async () => {
    const response = await fetch(url)
    assert.equal(response.status, 200)
    return response.text()
  }
  const setSha = (sha: string | null) => db.prepare('UPDATE tasks SET commit_sha = ? WHERE id = ?').run(sha, 'task')
  try {
    insertTask({ id: 'task', repo, branch: 'test', prompt: 'noop', status: 'completed', log: '', createdAt: new Date().toISOString() })
    assert.match(await html(), /No changed files/)
    const hostile = '<img>&"\'\nnew.txt'
    fs.writeFileSync(path.join(repo, hostile), 'PRIVATE_UNTRACKED_CONTENT')
    // A dangling symlink also must be listed without opening its target.
    fs.symlinkSync('missing-target', path.join(repo, 'link'))
    const untracked = await html()
    assert.match(untracked, /2 changed files: 0 added, 0 modified, 0 deleted, 0 renamed, 0 copied, 2 untracked/)
    assert.match(untracked, /&lt;img&gt;&amp;&quot;&#39;\nnew.txt/)
    assert.match(untracked, /<code>\?<\/code> <code>link<\/code>/)
    assert.match(untracked, /No tracked patch/)
    assert.doesNotMatch(untracked, /No changed files|PRIVATE_UNTRACKED_CONTENT|<img>/)

    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n')
    fs.writeFileSync(path.join(repo, 'added.txt'), 'added\n')
    git('add', 'added.txt')
    const mixed = await html()
    assert.match(mixed, /4 changed files: 1 added, 1 modified, 0 deleted, 0 renamed, 0 copied, 2 untracked/)
    assert.match(mixed, /aria-label="Unified diff"/)
    assert.match(mixed, /<code>M<\/code> <a href="#patch-section-\d+"><code>tracked.txt<\/code><\/a>/)
    git('add', 'tracked.txt')
    git('commit', '-qm', 'task commit')
    const sha = git('rev-parse', 'HEAD')
    setSha(sha)
    fs.writeFileSync(path.join(repo, 'later.txt'), 'later commit\n')
    git('add', 'later.txt')
    git('commit', '-qm', 'later')
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'later dirty checkout\n')
    const recorded = await html()
    assert.match(recorded, new RegExp(`Recorded commit changes: <code>${sha}</code>`))
    assert.match(recorded, /2 changed files: 1 added, 1 modified, 0 deleted, 0 renamed, 0 copied, 0 untracked/)
    assert.doesNotMatch(recorded, /later|&lt;img&gt;|<code>link<\/code>/)
    setSha(rootSha)
    assert.match(await html(), /1 changed files: 1 added, 0 modified/)

    setSha(null)
    fs.unlinkSync(path.join(repo, hostile))
    fs.unlinkSync(path.join(repo, 'link'))
    git('restore', 'tracked.txt')
    for (let i = 0; i < CHANGED_FILES_LIMIT + 3; i++) {
      fs.writeFileSync(path.join(repo, `new-${String(i).padStart(4, '0')}.txt`), 'NEVER_SERVE_THIS')
    }
    const capped = await html()
    assert.match(capped, new RegExp(`${CHANGED_FILES_LIMIT + 3} changed files: 0 added`))
    assert.match(capped, new RegExp(`File list truncated: showing ${CHANGED_FILES_LIMIT} of ${CHANGED_FILES_LIMIT + 3}`))
    assert.equal((capped.match(/<li>/g) ?? []).length, CHANGED_FILES_LIMIT)
    assert.doesNotMatch(capped, /new-2000.txt|NEVER_SERVE_THIS/)
    for (const invalid of ['<script>bad</script>', 'f'.repeat(40)]) {
      setSha(invalid)
      const failed = await fetch(url)
      assert.equal(failed.status, 503)
      assert.deepEqual(await failed.json(), { error: 'could not inspect repository changes' })
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
