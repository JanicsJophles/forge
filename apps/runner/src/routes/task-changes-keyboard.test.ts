import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import express from 'express'
import ts from 'typescript'

// Mount the actual route with offline DB/Git fixtures; never open the task store.
const source = fs.readFileSync(new URL('./task-changes-view.ts', import.meta.url), 'utf8')
const hostile = '<script>alert("patch")</script><img onerror=bad>& 雪' + 'x'.repeat(12000)
const patch = `diff --git a/file b/file\n@@ -1 +1 @@\n-${hostile}\n+${hostile}\n`

test('served patch has one named tab stop, native controls and inert literal text', async t => {
  let currentPatch = patch
  let truncated = false
  let mode = 'ok'
  const router = express.Router()
  const body = source.replace(/^import .*\n/gm, '').replace(/export /g, '')
  new Function('Router', 'db', 'getChangesPatch', 'getChangedFiles', 'summarizeChangedFiles', 'boundChangedFiles', 'getCurrentBranch', ts.transpile(body, { target: ts.ScriptTarget.ES2022 }))(
    () => router,
    { prepare: () => ({ get: () => mode === 'missing' ? undefined : ({ repo: '/offline', branch: 'recorded', status: 'completed' }) }) },
    () => { if (mode === 'unavailable') throw new Error('private diagnostic'); return { patch: currentPatch, truncated } },
    () => [],
    () => ({ total: 1, modified: 1 }),
    () => ({ changedFiles: [{ path: 'file', status: 'M' }], truncated: false }),
    () => 'different-branch',
  )
  const server = express().use('/tasks', router).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/tasks/offline/changes/view`
  for (const isTruncated of [false, true]) {
    truncated = isTruncated
    const response = await fetch(url)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-patch-truncated'), String(truncated))
    const html = await response.text()
    const pre = html.match(/<pre id="unified-diff"[^>]*>([\s\S]*?)<\/pre>/)!
    assert.match(pre[0], /^<pre[^>]*aria-label="Unified diff" role="region" tabindex="0">/)
    assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1)
    assert.match(html, /#unified-diff:focus-visible\s*\{[^}]*outline: 2px solid #34d399; outline-offset: -2px;/)
    assert.match(html, /pre \{ overflow: auto;/)
    assert.match(html, /#wrap-lines:checked ~ pre \{ white-space: pre-wrap; overflow-wrap: anywhere;/)
    assert.match(html, /<input type="checkbox" id="wrap-lines" aria-controls="unified-diff" \/>/)
    assert.match(html, /<label for="wrap-lines">Wrap lines<\/label>/)
    assert.match(html, /href="#patch-section-0"/)
    assert.match(pre[1], /id="patch-section-0" tabindex="-1"/)
    assert.match(html, /<details aria-label="Changed file list" open>/)
    assert.match(html, /class="warning" role="status">Warning:/)
    assert.equal(html.includes('Patch truncated: only'), truncated)
    const decoded = pre[1].replace(/<\/?span[^>]*>/g, '').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    assert.equal(decoded, patch)
    assert.doesNotMatch(pre[0], /aria-live|<script|<img|onkeydown|onkeyup/)
    assert.doesNotMatch(html, /<script|autofocus|contenteditable/)
  }
  currentPatch = ''
  assert.match(await (await fetch(url)).text(), /No tracked patch to display/)
  for (const [state, status] of [['missing', 404], ['unavailable', 503]] as const) {
    mode = state
    const response = await fetch(url)
    assert.equal(response.status, status)
    const html = await response.text()
    assert.match(html, /<nav aria-label="Review navigation">/)
    for (const href of ['/tasks/offline/log/view', '/history', '/dashboard']) assert.ok(html.includes(`href="${href}"`))
    assert.equal(html.includes('>Retry changes</a>'), state === 'unavailable')
    assert.doesNotMatch(html, /tabindex|autofocus|<script|private diagnostic|id="unified-diff"/)
  }
})
