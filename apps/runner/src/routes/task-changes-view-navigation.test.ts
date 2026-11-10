import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

// Exercise the pure parser offline without opening the runner's SQLite store.
const source = fs.readFileSync(new URL('./task-changes-view.ts', import.meta.url), 'utf8')
const pure = source.slice(source.indexOf('function gitPath'), source.indexOf('taskChangesViewRouter.get'))
const js = ts.transpile(pure.replace('export function', 'function'), { target: ts.ScriptTarget.ES2022 })
const navigate = new Function(`${js}; return patchNavigation`)() as
  (patch: string) => { targets: Map<string, string>; anchors: Map<number, string> }

test('navigation identifies real Git headers with spaces, Unicode, quotes, renames and escaped bytes', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-navigation-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' })
  try {
    git('init', '-q')
    const names = ['space name', '雪.txt', 'quote"file', 'line\nfile', '<img onerror="bad">&', 'old name']
    for (const name of names) fs.writeFileSync(path.join(repo, name), 'original\n')
    git('add', '--', ...names)
    git('commit', '-qm', 'initial')
    for (const name of names.slice(0, -1)) fs.writeFileSync(path.join(repo, name), 'changed\n')
    git('mv', 'old name', 'new name')
    for (const quotePath of ['true', 'false']) {
      const patch = git('-c', `core.quotepath=${quotePath}`, 'diff', 'HEAD', '--no-color')
      const { targets, anchors } = navigate(patch)
      for (const name of [...names.slice(0, -1), 'new name']) {
        assert.ok(targets.has(name), `${quotePath}: ${name}`)
        assert.match(targets.get(name)!, /^patch-section-\d+$/)
        assert.ok([...anchors.values()].includes(targets.get(name)!))
      }
    }
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
})

test('ambiguous, duplicate, malformed and omitted headers never create file links', () => {
  const header = 'diff --git a/one b/one\n'
  assert.equal(navigate(header + header).targets.size, 0)
  assert.equal(navigate('diff --git a/x b/y b/z\n').targets.size, 0)
  assert.equal(navigate('diff --git a/one b/on').targets.size, 0)
  assert.equal(navigate('diff --git "a/\\q" "b/\\q"\n').targets.size, 0)
  assert.equal(navigate(header).targets.has('untracked'), false)
  assert.equal(navigate(header).targets.has('omitted-by-cap'), false)
  assert.match(source, /file.status === '\?'/)
  assert.match(source, /escapeHtml\(file.path\)/)
  assert.match(source, /no identified patch section/)
  assert.match(source, /href="#\$\{target\}"/)
})

test('rendered links resolve to opaque targets and hostile names stay escaped', () => {
  let handler: (req: unknown, res: unknown) => void = () => {}
  const name = '<svg onload="bad">&雪'
  const patch = `diff --git "a/<svg onload=\\"bad\\">&雪" "b/<svg onload=\\"bad\\">&雪"\n+<script>\n`
  const body = source.replace(/^import .*\n/gm, '').replace(/export /g, '')
  new Function('Router', 'db', 'getChangesPatch', 'getChangedFiles', 'summarizeChangedFiles', 'boundChangedFiles', ts.transpile(body, { target: ts.ScriptTarget.ES2022 }))(
    () => ({ get: (_: string, callback: typeof handler) => { handler = callback } }),
    { prepare: () => ({ get: () => ({ repo: '/temporary', commit_sha: 'recorded' }) }) },
    () => ({ patch, truncated: true }),
    () => [{ path: name, status: 'M' }, { path: 'untracked', status: '?' }, { path: 'omitted', status: 'M' }],
    () => ({ total: 3 }),
    (files: unknown[]) => ({ changedFiles: files, truncated: false }),
  )
  let html = ''
  const response = { setHeader() {}, type() { return this }, send(value: string) { html = value } }
  handler({ params: { id: 'task' } }, response)
  assert.match(html, /href="#patch-section-0"/)
  assert.match(html, /id="patch-section-0" tabindex="-1"/)
  assert.match(html, /&lt;svg onload=&quot;bad&quot;&gt;&amp;雪/)
  assert.doesNotMatch(html, /<svg|<script>/)
  assert.equal((html.match(/no identified patch section/g) ?? []).length, 2)
  assert.match(html, /Recorded commit changes/)
  assert.match(html, /Patch truncated/)
})
