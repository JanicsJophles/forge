import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'

test('browser errors escape IDs, keep navigation, and recover only on explicit retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-view-errors-'))
  const bin = path.join(root, 'bin')
  const calls = path.join(root, 'calls')
  const fail = path.join(root, 'fail')
  const failPatch = path.join(root, 'fail-patch')
  fs.mkdirSync(bin)
  fs.writeFileSync(fail, '')
  // Return a partial patch before the file probe fails: neither output may leak.
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, 'call\\n');
if (process.argv.includes('--name-status')) {
  if (fs.existsSync(${JSON.stringify(fail)})) {
    process.stderr.write('secret-credential https://user:password@example.invalid exception-detail');
    process.exit(128);
  }
  process.stdout.write('M\\0safe.txt\\0');
} else {
  if (fs.existsSync(${JSON.stringify(failPatch)})) process.exit(128);
  process.stdout.write('diff --git a/safe.txt b/safe.txt\\n+private-patch-text\\n');
}
`, { mode: 0o755 })
  const originalPath = process.env.PATH
  process.env.PATH = `${bin}:${originalPath}`
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
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const hostile = '\"><svg onload=alert(1)>/../?token="&x=#'
  const url = `${base}/tasks/${encodeURIComponent(hostile)}/changes/view`
  const count = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0
  const checkError = async (response: Response, status: number) => {
    assert.equal(response.status, status)
    assert.match(response.headers.get('content-type') ?? '', /text\/html/)
    assert.equal(response.headers.get('x-patch-truncated'), null)
    const html = await response.text()
    const logHref = `/tasks/${encodeURIComponent(hostile).replace(/'/g, '&#39;')}/log/view`
    assert.ok(html.includes(`<a href="${logHref}">task logs</a>`))
    assert.equal((html.match(/>task logs<\/a>/g) ?? []).length, 1)
    assert.match(html, /<nav aria-label="Review navigation">/)
    assert.match(html, /href="\/history"/)
    assert.match(html, /href="\/dashboard"/)
    assert.match(html, /&quot;&gt;&lt;svg/)
    assert.doesNotMatch(html, /<svg|secret-credential|password|exception-detail|private-patch-text|http-equiv|<script/)
    assert.ok(html.length < (status === 404 ? 2500 : 6000))
    return html
  }
  try {
    const missing = await checkError(await fetch(url), 404)
    assert.match(missing, /may have been pruned/)
    assert.doesNotMatch(missing, /Retry changes/)
    assert.equal(count(), 0)
    insertTask({ id: hostile, repo: root, branch: 'test', prompt: 'noop', status: 'completed', log: '', createdAt: new Date().toISOString() })
    db.prepare('UPDATE tasks SET commit_sha = ? WHERE id = ?').run('a'.repeat(40), hostile)
    const failed = await checkError(await fetch(url), 503)
    assert.equal(count(), 2, 'one patch probe and one file probe, no automatic retry')
    const retry = failed.match(/href="([^"]+)">Retry changes/)
    assert.ok(retry)
    const retryUrl = new URL(retry[1].replace(/&#39;/g, "'"), base)
    assert.equal(retryUrl.origin, base)
    assert.equal(retryUrl.href, url)

    // Existing API contracts remain JSON even when the browser viewer is HTML.
    fs.writeFileSync(failPatch, '')
    for (const suffix of ['', '?format=patch']) {
      const response = await fetch(url.replace('/changes/view', `/changes${suffix}`))
      assert.equal(response.status, 503)
      assert.match(response.headers.get('content-type') ?? '', /application\/json/)
      assert.deepEqual(await response.json(), { error: 'could not inspect repository changes' })
    }
    const missingApi = await fetch(`${base}/tasks/unknown/changes`)
    assert.equal(missingApi.status, 404)
    assert.deepEqual(await missingApi.json(), { error: 'task not found' })
    fs.unlinkSync(fail)
    fs.unlinkSync(failPatch)
    const recovered = await fetch(retryUrl)
    assert.equal(recovered.status, 200)
    const html = await recovered.text()
    assert.match(html, /Recorded commit changes/)
    assert.match(html, /private-patch-text/)
    assert.match(html, /safe.txt/)
    assert.doesNotMatch(html, /Changes temporarily unavailable/)
  } finally {
    process.env.PATH = originalPath
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
