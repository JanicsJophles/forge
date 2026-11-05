import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { AgentTask, TaskEvent } from '@forge/shared'

const dir = mkdtempSync(join(tmpdir(), 'forge-autocommit-'))
process.env.DATA_DIR = dir
process.env.ALLOWED_REPO_PATHS = dir
const { runTask, killTask, countActiveProcs } = await import('./runner.js')
const { insertTask, getTask, countActiveTasks } = await import('../db/queries.js')
const { createEmitter, getEmitter } = await import('./stream.js')
const { db } = await import('../db/schema.js')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

for (const mode of ['failure', 'non-error-failure', 'commit', 'clean', 'disabled'] as const) {
  test(`auto-commit result: ${mode}`, async () => {
    const failure = mode === 'failure' || mode === 'non-error-failure'
    const task: AgentTask = { id: mode, repo: dir, branch: 'test', prompt: 'test',
      status: 'queued', log: '', createdAt: new Date().toISOString(), autoCommit: mode !== 'disabled' }
    insertTask(task)
    const emitter = createEmitter(task.id)
    const events: TaskEvent[] = []
    let done = 0
    let commits = 0
    emitter.on('event', e => events.push(e))
    emitter.on('done', () => {
      done++
      assert.equal(getTask(task.id)?.status, failure ? 'failed' : 'completed')
    })
    const child = new EventEmitter() as any
    child.stdin = new EventEmitter()
    child.stdin.end = () => {}
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => assert.fail('closed child must never be killed')
    const timers: { callback: () => void; cleared: number }[] = []
    await runTask(task, emitter, {
      spawn: (() => child) as any,
      executionIdentity: (() => ({})) as any,
      gitPull: () => {},
      gitCommit: () => {
        commits++
        assert.equal(getTask(task.id)?.status, 'running')
        if (mode === 'failure') throw new Error('pre-commit hook rejected changes')
        if (mode === 'non-error-failure') throw 'index.lock exists'
        return mode === 'clean' ? null : 'fake-sha'
      },
      setTimeout: ((callback: () => void) => {
        const timer = { callback, cleared: 0, unref() {} }
        timers.push(timer)
        return timer
      }) as any,
      clearTimeout: ((timer: any) => { timer.cleared++ }) as any,
    })
    child.stdout.emit('data', Buffer.from('final agent output\n'))
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    child.emit('close', 0, null)
    timers[0].callback() // A queued timeout cannot act after close.

    const saved = getTask(task.id)!
    assert.equal(saved.status, failure ? 'failed' : 'completed')
    assert.ok(saved.completedAt)
    assert.match(saved.log, /final agent output/)
    assert.equal(saved.commitSha, mode === 'commit' ? 'fake-sha' : undefined)
    if (failure) {
      assert.match(saved.errorMessage!, /git commit failed: (pre-commit hook rejected changes|index.lock exists)/)
      assert.ok(saved.log.includes(saved.errorMessage!))
      assert.ok(events.find(e => e.type === 'error')?.data.includes(saved.errorMessage!))
    } else {
      assert.equal(saved.errorMessage, undefined)
      if (mode === 'clean') assert.match(saved.log, /no changes to commit/)
    }
    assert.equal(events.filter(e => e.type === 'error').length, failure ? 1 : 0)
    assert.equal(events.filter(e => e.type === 'complete').length, failure ? 0 : 1)
    assert.equal(done, 1)
    assert.equal(commits, mode === 'disabled' ? 0 : 1)
    assert.equal(countActiveProcs(), 0)
    assert.equal(countActiveTasks(), 0)
    assert.equal(killTask(task.id), false)
    assert.equal(getEmitter(task.id), undefined)
    assert.ok(timers.every(timer => timer.cleared === 1))
  })
}
