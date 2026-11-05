import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { AgentTask } from '@forge/shared'

const dir = mkdtempSync(join(tmpdir(), 'forge-launch-failure-'))
process.env.DATA_DIR = dir
process.env.ALLOWED_REPO_PATHS = dir
const { runTask, killTask, countActiveProcs } = await import('./runner.js')
const { insertTask, getTask, countActiveTasks } = await import('../db/queries.js')
const { createEmitter, getEmitter, countActiveEmitters } = await import('./stream.js')
const { db } = await import('../db/schema.js')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const secret = 'private-prompt-and-credential'
for (const [name, failure, expected] of [
  ['options', Object.assign(new TypeError(secret), { code: 'ERR_INVALID_ARG_VALUE' }), 'ERR_INVALID_ARG_VALUE'],
  ['permissions', Object.assign(new Error(secret), { code: 'EACCES' }), 'EACCES'],
  ['unknown-code', Object.assign(new Error(secret), { code: secret }), 'check provider installation'],
  ['non-error', secret, 'check provider installation'],
  ['null', null, 'check provider installation'],
] as const) {
  test(`synchronous launch failure: ${name}`, async () => {
    const task: AgentTask = { id: name, repo: dir, branch: 'test', prompt: secret,
      status: 'queued', log: '', createdAt: new Date().toISOString(), autoCommit: true }
    insertTask(task)
    const emitter = createEmitter(task.id)
    const events: { type: string; data: string }[] = []
    let done = 0
    let launches = 0
    emitter.on('event', event => events.push(event))
    emitter.on('done', () => done++)
    await runTask(task, emitter, {
      spawn: (() => { launches++; throw failure }) as any,
      executionIdentity: (() => ({})) as any,
      gitPull: () => {},
      gitCommit: () => { assert.fail('launch failure must not commit') },
      setTimeout: (() => { assert.fail('launch failure must not create timers') }) as any,
      clearTimeout: (() => { assert.fail('no launch timers to clear') }) as any,
    })
    const stored = getTask(task.id)!
    assert.equal(launches, 1)
    assert.equal(stored.status, 'failed')
    assert.ok(stored.completedAt)
    assert.match(stored.errorMessage!, /failed to launch claude/)
    assert.ok(stored.errorMessage!.includes(expected))
    assert.ok(!stored.log.includes(secret))
    assert.ok(!stored.errorMessage!.includes(secret))
    assert.ok(events.every(event => !event.data.includes(secret)))
    assert.equal(events.filter(event => event.type === 'error').length, 1)
    assert.equal(events.filter(event => event.type === 'complete').length, 0)
    assert.equal(done, 1)
    assert.equal(getEmitter(task.id), undefined)
    assert.equal(countActiveEmitters(), 0)
    assert.equal(countActiveProcs(), 0)
    assert.equal(countActiveTasks(), 0)
    assert.equal(killTask(task.id), false)
  })
}
