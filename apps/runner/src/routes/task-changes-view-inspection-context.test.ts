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
      assert.match(sql, /auto_commit,\s+created_at, started_at, completed_at,/)
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
      getChangesPatch: (repo: string, commit: string | null) => {
        assert.equal(repo, settings.repo ?? '/fake/repo')
        assert.equal(commit, settings.commit_sha ?? null)
        probes.push('patch')
        if (mode === 'checkout' || mode === 'commit') throw new Error('PRIVATE_DIAGNOSTICS')
        return { patch: 'diff --git a/file b/file\n+PRIVATE_PARTIAL_PATCH\n', truncated: false }
      },
      getChangedFiles: () => { probes.push('files'); throw new Error('PRIVATE_DIAGNOSTICS') },
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

test('inspection failures preserve bounded saved context without partial output or retries', () => {
  for (const mode of ['checkout', 'commit', 'footprint']) {
    const { html, status, probes } = review({ status: 'failed',
      commit_sha: mode === 'checkout' ? null : 'a'.repeat(40),
      provider: 'codex', model: 'saved-model', auto_commit: 0,
      failure_reason: 'Saved failure', created_at: '2026-11-13 01:00:00',
      started_at: '2026-11-13 01:01:00', completed_at: '2026-11-13 01:02:00',
    }, mode)
    assert.equal(status, 503)
    for (const text of ['saved prompt', 'Saved failure', 'saved-model', 'codex',
      'Auto-commit requested: <strong>no', 'Recorded task status: <strong>failed',
      'Created (UTC): 2026-11-13 01:00:00.000 UTC', 'Terminal duration: 60 seconds',
      '/fake/repo', 'Recorded task branch: <code>saved', 'Patch and changed-file footprint are unavailable',
      'Retry changes', 'task logs', 'task history', 'dashboard']) assert.ok(html.includes(text), text)
    assert.ok(html.includes(mode === 'checkout' ? 'not recorded' : 'a'.repeat(40)))
    assert.doesNotMatch(html, /PRIVATE_|No changed files|No tracked changes|0 changed files|Unified diff/)
    assert.deepEqual(probes, mode === 'footprint' ? ['patch', 'files'] : ['patch'])
  }
})

test('unavailable review escapes hostile metadata and retains truncation notices', () => {
  const hostile = '<script>alert("x")</script>&'
  const { html, status } = review({ repo: hostile, branch: hostile, commit_sha: hostile,
    status: 'failed', provider: hostile, model: hostile, failure_reason: hostile,
    failure_truncated: 1, prompt_prefix: Buffer.from(hostile), prompt_bytes: 20000,
    created_at: hostile, started_at: null, completed_at: null,
  }, 'commit')
  assert.equal(status, 503)
  assert.doesNotMatch(html, /<script|PRIVATE_ log/)
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;'))
  assert.match(html, /Prompt truncated: showing at most 16384 UTF-8 bytes/)
  assert.match(html, /Failure reason truncated: showing the first 2000 characters/)
  assert.match(html, /Created \(UTC\): invalid timestamp/)
})
