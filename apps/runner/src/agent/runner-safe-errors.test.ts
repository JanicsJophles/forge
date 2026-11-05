import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { AgentTask } from '@forge/shared'

const dir = mkdtempSync(join(tmpdir(), 'forge-safe-errors-'))
process.env.DATA_DIR = dir
process.env.ALLOWED_REPO_PATHS = dir
const { runTask, killTask, countActiveProcs } = await import('./runner.js')
const { insertTask, getTask, updateTaskStatus, setErrorMessage } = await import('../db/queries.js')
const { createEmitter, getEmitter } = await import('./stream.js')
const { db } = await import('../db/schema.js')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const secret = '/credentials/token-super-secret'
const failures: unknown[] = [
  ...['ENOENT', 'EACCES', secret].map(code => Object.assign(new Error(secret), { code })),
  secret, null,
]
for (const stage of ['identity', 'login', 'async', 'cancel', 'timeout'] as const) {
  for (const [index, failure] of failures.entries()) {
    test(`${stage} failure ${index} never exposes diagnostics`, async () => {
      const task: AgentTask = { id: `${stage}-${index}`, repo: dir, branch: 'test', prompt: 'test',
        provider: 'codex', status: 'queued', log: '', createdAt: new Date().toISOString(), autoCommit: true }
      insertTask(task)
      const emitter = createEmitter(task.id)
      const events: { type: string; data: string }[] = []
      let done = 0
      emitter.on('event', event => events.push(event))
      emitter.on('done', () => done++)
      const child = new EventEmitter() as any
      child.stdin = new EventEmitter()
      child.stdin.end = () => {}
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => true
      const timers: { callback: () => void; cleared: number }[] = []
      await runTask(task, emitter, {
        executionIdentity: (() => { if (stage === 'identity') throw failure; return {} }) as any,
        checkCodexLogin: async () => { if (stage === 'login') throw failure },
        spawn: (() => child) as any,
        gitPull: () => {},
        gitCommit: () => { assert.fail('failed tasks must never commit') },
        setTimeout: ((callback: () => void) => {
          const timer = { callback, cleared: 0, unref() {} }
          timers.push(timer)
          return timer
        }) as any,
        clearTimeout: ((timer: any) => { timer.cleared++ }) as any,
      })
      if (stage === 'async' || stage === 'cancel' || stage === 'timeout') {
        if (stage === 'cancel') killTask(task.id)
        if (stage === 'timeout') timers[0].callback()
        child.emit('error', failure)
        assert.equal(done, 0)
        assert.equal(countActiveProcs(), 1)
        assert.equal(getTask(task.id)!.status, 'running')
        assert.equal(getEmitter(task.id), emitter)
        child.emit('close', 0, null)
        child.emit('close', 0, null)
      }
      const stored = getTask(task.id)!
      assert.equal(stored.status, 'failed')
      assert.ok(stored.completedAt)
      assert.ok(!stored.log.includes(secret))
      assert.ok(!stored.errorMessage!.includes(secret))
      assert.ok(events.every(event => !event.data.includes(secret)))
      assert.match(stored.errorMessage!, stage === 'identity' ? /runner identity failed/
        : stage === 'login' ? /login probe failed/ : stage === 'cancel' ? /cancelled/
        : stage === 'timeout' ? /timed out/ : /failed to launch codex/)
      if (stage === 'async' && index < 2) assert.ok(stored.errorMessage!.includes(index === 0 ? 'ENOENT' : 'EACCES'))
      assert.equal(events.filter(event => event.type === 'error').length, 1)
      assert.equal(events.filter(event => event.type === 'complete').length, 0)
      assert.equal(done, 1)
      assert.equal(countActiveProcs(), 0)
      assert.equal(getEmitter(task.id), undefined)
      assert.ok(timers.every(timer => timer.cleared === 1))
    })
  }
}

for (const reason of ['Codex login check timed out', 'Codex login probe failed (exit code 1)',
  'Codex CLI is unavailable for the configured runner account', 'Codex login probe failed (signal SIGTERM)']) {
  test(`controlled login reason: ${reason}`, async () => {
    const task: AgentTask = { id: reason, repo: dir, branch: 'test', prompt: 'test', provider: 'codex',
      status: 'queued', log: '', createdAt: new Date().toISOString() }
    insertTask(task)
    await runTask(task, createEmitter(task.id), {
      executionIdentity: (() => ({})) as any,
      checkCodexLogin: async () => { throw new Error(reason) },
      spawn: (() => assert.fail('no CLI')) as any, gitPull: () => assert.fail('no git'),
      gitCommit: () => assert.fail('no commit'), setTimeout, clearTimeout,
    })
    assert.ok(getTask(task.id)!.errorMessage!.includes(reason))
  })
}

test('cancellation while login fails preserves saved reason', async () => {
  const task: AgentTask = { id: 'setup-cancel', repo: dir, branch: 'test', prompt: 'test', provider: 'codex',
    status: 'queued', log: '', createdAt: new Date().toISOString() }
  insertTask(task)
  await runTask(task, createEmitter(task.id), {
    executionIdentity: (() => ({})) as any,
    checkCodexLogin: async () => {
      setErrorMessage(task.id, 'Task cancelled')
      updateTaskStatus(task.id, 'failed')
      throw new Error(secret)
    },
    spawn: (() => assert.fail('no CLI')) as any, gitPull: () => assert.fail('no git'),
    gitCommit: () => assert.fail('no commit'), setTimeout, clearTimeout,
  })
  assert.equal(getTask(task.id)!.errorMessage, 'Task cancelled')
  assert.ok(!getTask(task.id)!.log.includes(secret))
})
