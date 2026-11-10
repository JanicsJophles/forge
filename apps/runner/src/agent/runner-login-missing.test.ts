import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { AgentTask } from '@forge/shared'

const dir = mkdtempSync(join(tmpdir(), 'forge-login-missing-'))
process.env.DATA_DIR = dir
process.env.ALLOWED_REPO_PATHS = dir
const { runTask, countActiveProcs, killTask } = await import('./runner.js')
const { insertTask, getTask, countActiveTasks } = await import('../db/queries.js')
const { createEmitter, getEmitter, countActiveEmitters } = await import('./stream.js')
const { db } = await import('../db/schema.js')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const missing = 'Codex CLI was not found on PATH for the configured runner user'
const secret = 'fake-token-private-prompt'
const fallback = 'Codex login probe failed; check CLI installation and login for the configured runner account'
const controlled = [missing, 'Codex CLI is unavailable for the configured runner account',
  'Codex login check timed out', 'Codex login probe failed (exit code 1)',
  'Codex login probe failed (exit code unknown)', 'Codex login probe failed (signal SIGTERM)']
const cases: [unknown, string][] = [
  ...controlled.map(reason => [new Error(reason), reason] as [unknown, string]),
  [new Error(secret), fallback],
  [new Error(`${missing}: ${secret}`), fallback],
  [new Error(`${secret}\n${missing}`), fallback],
  [new Error(`Codex login probe failed (exit code ${secret})`), fallback],
  [new Error(`Codex login probe failed (signal ${secret})`), fallback],
  [secret, fallback], [null, fallback],
]
for (const [index, [failure, expected]] of cases.entries()) {
  test(`login rejection ${index} persists only the safe reason and releases lifecycle state`, async () => {
    const task: AgentTask = { id: `login-${index}`, repo: dir, branch: 'test', prompt: secret,
      provider: 'codex', status: 'queued', log: '', createdAt: new Date().toISOString(), autoCommit: true }
    insertTask(task)
    const emitter = createEmitter(task.id)
    const events: { type: string; data: string }[] = []
    let done = 0
    let probes = 0
    emitter.on('event', event => events.push(event))
    emitter.on('done', () => done++)
    await runTask(task, emitter, {
      executionIdentity: (() => ({})) as any,
      checkCodexLogin: async () => { probes++; throw failure },
      spawn: (() => assert.fail('must not launch provider')) as any,
      gitPull: () => assert.fail('must not pull'),
      gitCommit: () => assert.fail('must not commit'),
      setTimeout: (() => assert.fail('must not schedule provider timers')) as any,
      clearTimeout: (() => assert.fail('no provider timers to clear')) as any,
    })
    const message = `[forge] codex setup failed: ${expected}`
    const stored = getTask(task.id)!
    assert.equal(probes, 1)
    assert.equal(stored.status, 'failed')
    assert.ok(stored.completedAt)
    assert.equal(stored.errorMessage, message)
    assert.equal(stored.log, message + '\n')
    assert.deepEqual(events.map(({ type, data }) => ({ type, data })), [{ type: 'error', data: message }])
    assert.ok(!stored.log.includes(secret))
    assert.equal(done, 1)
    assert.equal(getEmitter(task.id), undefined)
    assert.equal(countActiveEmitters(), 0)
    assert.equal(countActiveProcs(), 0)
    assert.equal(countActiveTasks(), 0)
    assert.equal(killTask(task.id), false)
  })
}
