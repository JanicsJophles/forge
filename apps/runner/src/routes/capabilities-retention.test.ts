import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

for (const [policy, days] of [[undefined, 0], ['0', 0], ['30', 30], ['invalid', 0]] as const) {
  test(`retention discovery is static and read-only for ${policy ?? 'unset'} policy`, () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'forge-caps-retention-'))
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
        const { capabilitiesRouter } = await import(${JSON.stringify(new URL('./capabilities.ts', import.meta.url).href)})
        const { config } = await import(${JSON.stringify(new URL('../config.ts', import.meta.url).href)})
        const app = express()
        app.use(capabilitiesRouter)
        const server = app.listen(0, '127.0.0.1')
        await new Promise(resolve => server.once('listening', resolve))
        try {
          // Environment changes and repeated polls cannot reevaluate the policy.
          process.env.TASK_RETENTION_DAYS = 'invalid-after-import'
          for (let i = 0; i < 3; i++) {
            const response = await fetch('http://127.0.0.1:' + server.address().port + '/capabilities')
            assert.equal(response.status, 200)
            const body = await response.json()
            assert.deepEqual(body.retention, { enabled: ${days > 0}, days: ${days}, intervalSeconds: 86400 })
            assert.equal(body.build.version, body.version)
            assert.equal(body.authRequired, config.authToken !== undefined)
            assert.equal(body.limits.autoCommit, config.autoCommit)
            assert.equal(body.logging.maxSliceBytes, 262144)
            assert.deepEqual(body.providers, ['claude', 'codex'])
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
