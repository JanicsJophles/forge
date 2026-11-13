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

test('SQLite UTC and zoned ISO dates normalize consistently for completed and failed tasks', () => {
  for (const status of ['completed', 'failed']) {
    const { html, probes } = review({ status, created_at: '2026-11-13 01:00:00',
      started_at: '2026-11-13T03:01:00+02:00', completed_at: '2026-11-12T20:02:30-05:00' })
    assert.match(html, /Created \(UTC\): 2026-11-13 01:00:00.000 UTC/)
    assert.match(html, /Started \(UTC\): 2026-11-13 01:01:00.000 UTC/)
    assert.match(html, /Finished \(UTC\): 2026-11-13 01:02:30.000 UTC/)
    assert.match(html, /Terminal duration: 90 seconds/)
    assert.deepEqual(probes, ['patch', 'files', 'branch'])
  }
})

test('active and legacy reviews distinguish pending and absent recorded values', () => {
  for (const status of ['queued', 'running', null, 'completed', 'failed']) {
    const { html } = review({ status, created_at: null, started_at: null, completed_at: null })
    assert.match(html, /Created \(UTC\): not recorded/)
    assert.ok(html.includes(`Started (UTC): ${status === 'queued' ? 'not started' : 'not recorded'}`))
    const active = status === 'queued' || status === 'running'
    assert.ok(html.includes(`Finished (UTC): ${active ? 'not finished' : 'not recorded'}`))
    assert.equal(html.includes('Refresh this task review'), active)
    assert.doesNotMatch(html, /<script|http-equiv="refresh"|Terminal duration: \d/)
  }
  const { html } = review({ status: 'running', started_at: '2026-11-13 01:00:00' })
  assert.match(html, /Started \(UTC\): 2026-11-13 01:00:00.000 UTC/)
  assert.match(html, /Terminal duration: not finished/)
})

test('invalid dates are distinct from absent dates and never create durations', () => {
  for (const invalid of ['', '<script>evil()</script>', '2026-02-30 01:00:00',
    '2026-11-13T01:00:00', '2026-11-13T01:00:00+25:00', '2026-11-13 24:00:00']) {
    const { html } = review({ created_at: invalid, started_at: invalid, completed_at: '2026-11-13T02:00:00Z' })
    assert.match(html, /Created \(UTC\): invalid timestamp/)
    assert.match(html, /Started \(UTC\): invalid timestamp/)
    assert.match(html, /Terminal duration: unavailable \(invalid timestamp\)/)
    assert.doesNotMatch(html, /<script|evil|NaN/)
  }
  assert.match(review({ started_at: '2026-11-13 01:00:00', completed_at: 'invalid' }).html,
    /Finished \(UTC\): invalid timestamp/)
})

test('reversed terminal timestamps explain clock skew without a fabricated duration', () => {
  const { html } = review({ started_at: '2026-11-13T01:00:01.500Z', completed_at: '2026-11-13 01:00:00' })
  assert.match(html, /Terminal duration: unavailable \(finish precedes start; clock skew\)/)
  assert.match(review({ started_at: '2026-11-13 01:00:00', completed_at: '2026-11-13T01:00:00.500Z' }).html,
    /Terminal duration: 0.5 seconds/)
})
