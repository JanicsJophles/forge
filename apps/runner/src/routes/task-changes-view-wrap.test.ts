import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import ts from 'typescript'

// Render the route with in-process fakes; never open the runner's task store.
const source = fs.readFileSync(new URL('./task-changes-view.ts', import.meta.url), 'utf8')
function render(patch: string, commit_sha: string | null = null): string {
  let handler: (req: unknown, res: unknown) => void = () => {}
  const body = source.replace(/^import .*\n/gm, '').replace(/export /g, '')
  new Function('Router', 'db', 'getChangesPatch', 'getChangedFiles', 'summarizeChangedFiles', 'boundChangedFiles', 'getCurrentBranch', ts.transpile(body, { target: ts.ScriptTarget.ES2022 }))(
    () => ({ get: (_: string, callback: typeof handler) => { handler = callback } }),
    { prepare: () => ({ get: () => ({ repo: '/temporary', branch: 'task-branch', commit_sha }) }) },
    () => ({ patch, truncated: false }),
    () => [],
    () => ({ total: 0 }),
    () => ({ changedFiles: [], truncated: false }),
    () => 'task-branch',
  )
  let html = ''
  const response = { setHeader() {}, type() { return this }, send(value: string) { html = value } }
  handler({ params: { id: 'task' } }, response)
  return html
}

const decode = (value: string) => value.replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')

test('native wrap checkbox switches only presentation, including without JavaScript', () => {
  const html = render('diff --git a/file b/file\n+long line\n')
  // Native :checked state supplies both directions without a handler or request.
  assert.match(html, /<input type="checkbox" id="wrap-lines" aria-controls="unified-diff" \/>/)
  assert.match(html, /<label for="wrap-lines">Wrap lines<\/label>/)
  assert.match(html, /id="wrap-lines"[^>]*>[\s\S]*<pre id="unified-diff" aria-label="Unified diff"[^>]*>/)
  assert.match(html, /#wrap-lines:checked ~ pre\s*\{\s*white-space: pre-wrap; overflow-wrap: anywhere;\s*\}/)
  assert.match(html, /#wrap-lines:checked ~ pre span\s*\{\s*width: 100%;\s*\}/)
  assert.match(html, /pre\s*\{ overflow: auto;/)
  assert.match(html, /pre span\s*\{ display: inline-block; min-width: 100%; \}/)
  assert.match(html, /\.added\s*\{[^}]*background: #052e16;/)
  assert.match(html, /\.removed\s*\{[^}]*background: #450a0a;/)
  assert.doesNotMatch(html, /<script|onchange=|onclick=|<input[^>]*\schecked[\s/>]/)
  assert.doesNotMatch(render(''), /id="wrap-lines"|id="unified-diff"/)
})

test('wrapping preserves every literal patch byte and raw link for hostile long lines', () => {
  const hostile = '<script>alert("x")</script><img onerror=bad>&amp;\' 雪\t' + 'x'.repeat(12_000)
  const patch = `diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-${hostile}\n+${hostile}changed\n`
  for (const sha of [null, 'recorded-sha']) {
    const html = render(patch, sha)
    const pre = html.match(/<pre id="unified-diff"[^>]*>([\s\S]*?)<\/pre>/)![1]
    assert.equal(decode(pre.replace(/<span[^>]*>|<\/span>/g, '')), patch)
    assert.match(pre, /class="added">\+/)
    assert.match(pre, /class="removed">-/)
    assert.doesNotMatch(pre, /<script|<img/)
    assert.match(html, /href="\/tasks\/task\/changes\?format=patch"/)
    assert.match(html, sha ? /Recorded commit changes/ : /Current tracked changes/)
  }
})
