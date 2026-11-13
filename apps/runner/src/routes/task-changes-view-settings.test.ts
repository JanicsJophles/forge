import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = fs.readFileSync(new URL('./task-changes-view.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText

function review(settings: Record<string, unknown>, mode = 'success') {
  let handler: (req: unknown, res: unknown) => void = () => assert.fail('missing route')
  const probes: string[] = []
  const modules: Record<string, unknown> = {
    express: { Router: () => ({ get: (_: string, callback: typeof handler) => { handler = callback } }) },
    '../db/schema.js': { db: { prepare: (sql: string) => {
      assert.match(sql, /SELECT repo, branch, commit_sha, status, provider, model, auto_commit,/)
      assert.match(sql, /substr\(CAST\(prompt AS BLOB\), 1, 16384\)/)
      assert.match(sql, /substr\(error_message, 1, 2000\)/)
      assert.doesNotMatch(sql, /SELECT\s+\*|\blog\b|SELECT\s+prompt\b|,\s*prompt\s*[,\n]/i)
      return { get: (id: string) => {
        assert.equal(id, 'task')
        return mode === 'missing' ? undefined : {
          repo: '/fake/repo', branch: 'saved', commit_sha: null, status: 'completed',
          prompt_prefix: Buffer.from('saved prompt'), prompt_bytes: 12, ...settings,
        }
      } }
    } } },
    '../agent/git.js': { getCurrentBranch: () => { probes.push('branch'); return 'saved' } },
    '../agent/git-changes.js': {
      getChangesPatch: () => {
        probes.push('patch')
        if (mode === 'unavailable') throw new Error('PRIVATE_DIAGNOSTICS')
        return { patch: 'diff --git a/file b/file\n+change\n', truncated: false }
      },
      getChangedFiles: () => { probes.push('files'); return [] },
      summarizeChangedFiles: () => ({ total: 0 }),
      boundChangedFiles: () => ({ changedFiles: [], truncated: false }),
    },
  }
  vm.runInNewContext(js, { exports: {}, TextDecoder, require: (name: string) => {
    assert.ok(name in modules, `unexpected dependency: ${name}`)
    return modules[name]
  } })
  let html = ''
  let status = 200
  const response = {
    status: (code: number) => { status = code; return response },
    setHeader: () => {}, type: () => response, send: (body: string) => { html = body },
  }
  handler({ params: { id: 'task' } }, response)
  return { html, status, probes }
}

test('saved launch settings preserve provider, explicit/default model and nullable auto-commit', () => {
  for (const provider of ['claude', 'codex', null]) {
    for (const model of ['explicit-model', null]) {
      for (const auto_commit of [1, 0, null]) {
        for (const commit_sha of [null, 'a'.repeat(40)]) {
          const { html, status, probes } = review({ provider, model, auto_commit, commit_sha })
          assert.equal(status, 200)
          assert.match(html, /aria-label="Saved launch settings"/)
          assert.ok(html.includes(`Provider: <strong>${provider ?? 'unspecified'}</strong>`))
          assert.ok(html.includes(`Model: <strong>${model ?? 'provider default'}</strong>`))
          assert.ok(html.includes(`Auto-commit requested: <strong>${auto_commit == null ? 'unspecified' : auto_commit ? 'yes' : 'no'}</strong>`))
          assert.match(html, commit_sha ? /Recorded commit changes/ : /Current tracked changes/)
          assert.deepEqual(probes, ['patch', 'files', ...(commit_sha ? [] : ['branch'])])
          assert.match(html, /id="unified-diff"[^>]*tabindex="0"/)
          assert.match(html, /id="patch-section-0" tabindex="-1"/)
          assert.match(html, /overflow-wrap: anywhere/)
        }
      }
    }
  }
})

test('stored launch text is escaped, never interpreted or replaced with runtime defaults', () => {
  const hostile = `<svg onload="evil()">&'`
  const { html } = review({ provider: hostile, model: hostile, auto_commit: null })
  assert.equal((html.match(/&lt;svg onload=&quot;evil\(\)&quot;&gt;&amp;&#39;/g) ?? []).length, 2)
  assert.doesNotMatch(html, /<svg|provider default/)
})

test('missing tasks omit metadata while unavailable Git retains saved settings and recovery', () => {
  for (const mode of ['missing', 'unavailable']) {
    const { html, status, probes } = review({ provider: 'PRIVATE_PROVIDER', model: 'PRIVATE_MODEL' }, mode)
    assert.equal(status, mode === 'missing' ? 404 : 503)
    assert.deepEqual(probes, mode === 'missing' ? [] : ['patch'])
    if (mode === 'missing') assert.doesNotMatch(html, /Saved launch settings|PRIVATE_/)
    else {
      assert.match(html, /Saved launch settings/)
      assert.match(html, /PRIVATE_PROVIDER/)
      assert.match(html, /PRIVATE_MODEL/)
    }
    assert.match(html, /task logs/)
    assert.match(html, /task history/)
    if (mode === 'missing') assert.doesNotMatch(html, /Retry changes/)
    else assert.match(html, /href="\/tasks\/task\/changes\/view">Retry changes/)
  }
})
