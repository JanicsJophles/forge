import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

for (const [policy, days] of [[undefined, 0], ['0', 0], ['30', 30], ['invalid', 0]] as const) {
  test(`landing retention is static and read-only for ${policy ?? 'unset'} policy`, () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'forge-root-retention-'))
    const env = {
      ...process.env,
      DATA_DIR: dataDir,
      ALLOWED_REPO_PATHS: dataDir,
      DOTENV_CONFIG_PATH: '/dev/null',
    }
    delete env.TASK_RETENTION_DAYS
    if (policy !== undefined) env.TASK_RETENTION_DAYS = policy
    try {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import assert from 'node:assert/strict'
        import { readdirSync } from 'node:fs'
        import childProcess from 'node:child_process'
        import { syncBuiltinESMExports } from 'node:module'
        import Database from 'better-sqlite3'
        import express from 'express'

        // Fail on startup pruning, SQLite reads, timers or provider CLI probes.
        const forbidden = () => { throw new Error('discovery started runner operations') }
        globalThis.setInterval = forbidden
        Database.prototype.prepare = forbidden
        Database.prototype.exec = forbidden
        for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
          childProcess[name] = forbidden
        }
        syncBuiltinESMExports()
        const warnings = []
        console.warn = (...args) => warnings.push(args)
        const { rootRouter } = await import(${JSON.stringify(new URL('./root.ts', import.meta.url).href)})
        const app = express()
        app.use(rootRouter)
        const server = app.listen(0, '127.0.0.1')
        await new Promise(resolve => server.once('listening', resolve))
        try {
          // Environment changes and repeated polls cannot reevaluate the policy.
          process.env.TASK_RETENTION_DAYS = 'invalid-after-import'
          for (let i = 0; i < 3; i++) {
            const response = await fetch('http://127.0.0.1:' + server.address().port + '/')
            assert.equal(response.status, 200)
            assert.match(response.headers.get('content-type'), /text\\/html/)
            const body = await response.text()
            const copy = body.match(/<p id="history-retention">([\\s\\S]*?)<\\/p>/)[1]
            if (${days} === 0) {
              assert.match(copy, /pruning is disabled \\(0 days\\)/)
              assert.doesNotMatch(copy, /eligible|at startup|every/)
            } else {
              assert.ok(copy.includes('terminal runs (completed or failed) older than ${days} days'))
              assert.match(copy, /eligible for pruning at startup and every 24 hours/)
            }
            assert.match(copy, /Queued and running tasks are retained/)
            assert.match(copy, /SQLite pages reusable; it does not shrink the database file/)
            assert.match(copy, /href="\\/history">Browse task history/)
            // No write controls or additional background discovery requests.
            assert.doesNotMatch(body, /<form|<button|setInterval/)
            const reads = [...body.matchAll(/readJson\\('([^']+)'\\)/g)].map(m => m[1])
            assert.ok(reads.includes('/tasks?limit=5'))
            assert.ok(reads.includes('/health'))
            assert.ok(reads.every(url => ['/tasks?limit=5', '/health', '/tasks/stats'].includes(url)))
            for (const id of ['repo-disk', 'data-disk', 'min-disk', 'accepting', 'tasks-freshness']) {
              assert.ok(body.includes('id="' + id + '"'))
            }
          }
          assert.equal(warnings.filter(args => String(args[0]).includes('TASK_RETENTION_DAYS')).length, ${policy === 'invalid' ? 1 : 0})
          assert.deepEqual(readdirSync(process.env.DATA_DIR), [])
        } finally {
          await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
        }
      `], { env, encoding: 'utf8', timeout: 20_000 })
      assert.equal(result.status, 0, result.stderr || String(result.error))
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
}
