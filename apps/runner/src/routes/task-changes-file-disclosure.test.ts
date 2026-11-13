import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import ts from 'typescript'

// Offline route fixtures: no SQLite, checkout, browser script, or Git probes.
const source = fs.readFileSync(new URL('./task-changes-view.ts', import.meta.url), 'utf8')
type File = { path: string; status: string }
function render(files: File[], capped = false) {
  let handler: (req: unknown, res: unknown) => void = () => {}
  let probes = 0
  const body = source.replace(/^import .*\n/gm, '').replace(/export /g, '')
  new Function('Router', 'db', 'getChangesPatch', 'getChangedFiles', 'summarizeChangedFiles', 'boundChangedFiles', 'getCurrentBranch', ts.transpile(body, { target: ts.ScriptTarget.ES2022 }))(
    () => ({ get: (_: string, callback: typeof handler) => { handler = callback } }),
    { prepare: () => ({ get: () => ({ repo: '/fixture', branch: 'fixture', status: 'completed', commit_sha: null }) }) },
    () => { probes++; return { patch: 'diff --git a/tracked b/tracked\n+safe\n', truncated: capped } },
    () => { probes++; return files },
    () => ({ total: files.length, added: 0, modified: files.filter(f => f.status === 'M').length,
      deleted: 0, renamed: 0, copied: 0, untracked: files.filter(f => f.status === '?').length }),
    () => ({ changedFiles: capped ? files.slice(0, 2000) : files, truncated: capped }),
    () => 'fixture',
  )
  let html = ''
  const response = { setHeader() {}, type() { return this }, send(value: string) { html = value } }
  handler({ params: { id: 'fixture' } }, response)
  assert.equal(probes, 2)
  return html
}
const files = (count: number): File[] => Array.from({ length: count }, (_, i) => ({ path: i ? `file-${i}` : 'tracked', status: 'M' }))

test('empty footprint stays explicit without an empty file disclosure', () => {
  const html = render([])
  assert.match(html, /No changed files\./)
  assert.doesNotMatch(html, /<details aria-label="Changed file list"/)
  assert.match(html, /aria-label="Unified diff"/)
})

test('native labelled disclosure opens through 20 files and collapses above 20, retaining counts', () => {
  for (const count of [1, 20, 21, 2000]) {
    const html = render(files(count))
    assert.ok(html.includes(`<details aria-label="Changed file list"${count <= 20 ? ' open' : ''}>`))
    assert.match(html, new RegExp(`<summary>${count} changed files: 0 added, ${count} modified, 0 deleted, 0 renamed, 0 copied, 0 untracked.</summary>`))
    assert.equal((html.match(/<li>/g) ?? []).length, count)
    // Native summary retains keyboard activation; no custom role or tabindex override.
    assert.match(html, /<summary>[^<]+<\/summary>/)
    assert.ok(html.indexOf('</details>', html.indexOf('<details aria-label="Changed file list"')) < html.indexOf('aria-label="Unified diff"'))
  }
})

test('truncation and untracked warnings remain outside the collapsed list', () => {
  const html = render([...files(2000), { path: 'untracked', status: '?' }], true)
  const disclosureEnd = html.indexOf('</details>', html.indexOf('<details aria-label="Changed file list"'))
  assert.match(html, /<summary>2001 changed files:.*1 untracked/)
  assert.equal((html.match(/<li>/g) ?? []).length, 2000)
  assert.ok(html.indexOf('File list truncated: showing 2000 of 2001') > disclosureEnd)
  assert.ok(html.indexOf('Patch truncated:') > disclosureEnd)
  assert.ok(html.indexOf('Untracked file contents are not included.') < html.indexOf('<details aria-label="Changed file list"'))
})

test('hostile names remain text and expanded list links resolve outside the disclosure', () => {
  const html = render([...files(21), { path: '<img onerror="bad">&\n雪', status: '?' }])
  assert.match(html, /&lt;img onerror=&quot;bad&quot;&gt;&amp;\n雪/)
  assert.doesNotMatch(html, /<img/)
  const target = /href="#(patch-section-\d+)"/.exec(html)![1]
  const targetIndex = html.indexOf(`id="${target}" tabindex="-1"`)
  assert.ok(targetIndex > html.indexOf('</details>', html.indexOf('<details aria-label="Changed file list"')))
  assert.match(html, /no identified patch section/)
})
