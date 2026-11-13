import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import express from 'express'

test('changes review distinguishes saved outcomes with bounded diagnostics and active snapshots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-outcome-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args,
  ], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'file'), 'initial\n')
  git('add', 'file')
  git('commit', '-qm', 'initial')
  const sha = git('rev-parse', 'HEAD')
  process.env.DATA_DIR = path.join(root, 'data')
  process.env.ALLOWED_REPO_PATHS = root
  process.env.MIN_FREE_DISK_MB = '1'
  const { taskChangesViewRouter } = await import('./task-changes-view.js')
  const { db } = await import('../db/schema.js')
  const server = express().use('/tasks', taskChangesViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const id = 'task <&"'
  const href = `/tasks/${encodeURIComponent(id)}/changes/view`
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}${href}`
  const get = async () => {
    const response = await fetch(url)
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.doesNotMatch(html, /PRIVATE_LOG/)
    assert.match(html, /<pre class="saved-prompt">PRIVATE_PROMPT<\/pre>/)
    return html
  }
  const update = (status: string, reason: string | null = null, commit: string | null = null) =>
    db.prepare('UPDATE tasks SET status = ?, error_message = ?, commit_sha = ? WHERE id = ?')
      .run(status, reason, commit, id)
  try {
    db.prepare('INSERT INTO tasks (id, repo, branch, prompt, log, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, repo, 'test', 'PRIVATE_PROMPT', 'PRIVATE_LOG', 'failed')
    update('failed', 'Provider setup failed <script> & "oops"')
    let html = await get()
    assert.match(html, /Recorded task status: <strong>failed<\/strong>/)
    assert.match(html, /Saved failure reason: Provider setup failed &lt;script&gt; &amp; &quot;oops&quot;/)
    assert.match(html, /No tracked changes/)
    assert.doesNotMatch(html, /<script>|Refresh this task/)

    update('completed')
    html = await get()
    assert.match(html, /Recorded task status: <strong>completed<\/strong>/)
    assert.match(html, /No tracked changes/)
    assert.doesNotMatch(html, /Saved failure reason|Task is active/)

    for (const status of ['queued', 'running']) {
      update(status)
      html = await get()
      assert.match(html, new RegExp(`Recorded task status: <strong>${status}</strong>`))
      assert.match(html, /displayed checkout diff is a snapshot and may change/)
      assert.ok(html.includes(`href="${href.replace(/&/g, '&amp;')}"`))
      assert.match(html, /Refresh this task review/)
    }
    update('running', null, sha)
    html = await get()
    assert.match(html, /Recorded commit changes/)
    assert.match(html, /displayed diff is from the recorded commit/)
    assert.doesNotMatch(html, /checkout diff is a snapshot/)

    // Legacy rows lack a reason/commit; unknown status must remain escaped.
    db.prepare('UPDATE tasks SET status = NULL WHERE id = ?').run(id)
    assert.match(await get(), /Recorded task status: <strong>unavailable<\/strong>/)
    update('failed')
    assert.match(await get(), /No saved failure reason is available/)
    update('legacy <img>')
    assert.match(await get(), /legacy &lt;img&gt;/)

    const hostile = '<img onerror="evil()">&'
    update('failed', hostile + '😀'.repeat(2000) + 'OMITTED_TAIL')
    html = await get()
    assert.match(html, /&lt;img onerror=&quot;evil\(\)&quot;&gt;&amp;/)
    assert.match(html, /Failure reason truncated: showing the first 2000 characters/)
    assert.doesNotMatch(html, /<img|OMITTED_TAIL|�/)
    update('failed', 'x'.repeat(2000))
    assert.doesNotMatch(await get(), /Failure reason truncated/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
