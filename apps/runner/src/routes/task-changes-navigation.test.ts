import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Exercise the route with narrow DB/Git fakes: navigation must not fetch logs or
// inspect the repository beyond the existing patch and file-list operations.
test('review navigation preserves hostile identity for checkout and recorded reviews', () => {
  const source = fs.readFileSync(new URL('./task-changes-view.ts', import.meta.url), 'utf8')
  const id = `'\"><svg onload=alert(1)>/../?token="&x=#雪`
  const escapedPath = `/tasks/${encodeURIComponent(id).replace(/'/g, '&#39;')}`
  for (const commitSha of [null, 'a'.repeat(40)]) {
    for (const patch of ['', 'diff --git a/file b/file\n+changed\n']) {
      let handler: (req: unknown, res: unknown) => void = () => assert.fail('route not registered')
      const probes: unknown[][] = []
      const modules: Record<string, unknown> = {
        express: { Router: () => ({ get: (route: string, callback: typeof handler) => {
          assert.equal(route, '/:id/changes/view')
          handler = callback
        } }) },
        '../db/schema.js': { db: { prepare: (sql: string) => {
          assert.equal(sql.replace(/\s+/g, ' ').trim(),
            'SELECT repo, branch, commit_sha, status, provider, model, auto_commit, substr(CAST(prompt AS BLOB), 1, 16384) AS prompt_prefix, length(CAST(prompt AS BLOB)) AS prompt_bytes, substr(error_message, 1, 2000) AS failure_reason, length(error_message) > 2000 AS failure_truncated FROM tasks WHERE id = ?')
          return { get: (taskId: string) => {
            assert.equal(taskId, id)
            return { repo: '/fake/repo', branch: 'test', status: 'failed', prompt_prefix: Buffer.from('Review navigation'), prompt_bytes: 17, failure_reason: 'saved reason', failure_truncated: 0, commit_sha: commitSha }
          } }
        } } },
        '../agent/git.js': { getCurrentBranch: (...args: unknown[]) => { probes.push(args); return 'test' } },
        '../agent/git-changes.js': {
          getChangesPatch: (...args: unknown[]) => { probes.push(args); return { patch, truncated: false } },
          getChangedFiles: (...args: unknown[]) => { probes.push(args); return [] },
          summarizeChangedFiles: () => ({ total: 0, added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, untracked: 0 }),
          boundChangedFiles: () => ({ changedFiles: [], truncated: false }),
        },
      }
      const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
      vm.runInNewContext(js, { exports: {}, TextDecoder, require: (name: string) => {
        assert.ok(name in modules, `unexpected dependency: ${name}`)
        return modules[name]
      } })
      let html = ''
      const response = {
        setHeader: () => {},
        type: (type: string) => { assert.equal(type, 'html'); return response },
        send: (body: string) => { html = body },
      }
      handler({ params: { id } }, response)
      assert.ok(html.includes(`<a href="${escapedPath}/log/view">task logs</a>`))
      assert.ok(html.includes(`<a href="${escapedPath}/changes?format=patch">raw patch</a>`))
      assert.match(html, /<nav aria-label="Review navigation">[\s\S]*href="\/history">task history/)
      assert.match(html, /href="\/dashboard"/)
      assert.match(html, commitSha ? /Recorded commit changes/ : /Current tracked changes/)
      assert.match(html, patch ? /aria-label="Unified diff"/ : /No tracked changes/)
      assert.doesNotMatch(html, /<svg/)
      assert.equal((html.match(/>task logs<\/a>/g) ?? []).length, 1)
      assert.match(html, /Review navigation<\/pre>/)
      assert.match(html, /Saved failure reason: saved reason/)
      assert.deepEqual(probes, [['/fake/repo', commitSha], ['/fake/repo', commitSha], ...(commitSha ? [] : [['/fake/repo']])])
    }
  }
})
