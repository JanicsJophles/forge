import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { AgentTask } from '@forge/shared'

const dir = mkdtempSync(join(tmpdir(), 'forge-lifecycle-'))
process.env.DATA_DIR = dir
process.env.ALLOWED_REPO_PATHS = dir
const { runTask, killTask, countActiveProcs } = await import('./runner.js')
const { insertTask, getTask, countActiveTasks } = await import('../db/queries.js')
const { createEmitter, getEmitter } = await import('./stream.js')
const { db } = await import('../db/schema.js')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

for (const mode of ['term-zero', 'timeout-zero', 'ignore', 'timeout', 'normal-race', 'exit-before-close', 'spawn-error'] as const) {
  test(`lifecycle: ${mode}`, async () => {
    const task: AgentTask = { id: mode, repo: dir, branch: 'test', prompt: 'test',
      status: 'queued', log: '', createdAt: new Date().toISOString(), autoCommit: true }
    insertTask(task)
    const emitter = createEmitter(task.id)
    const events: string[] = []
    let done = 0
    let commits = 0
    emitter.on('event', e => events.push(e.type))
    emitter.on('done', () => done++)
    const child = new EventEmitter() as any
    child.stdin = new EventEmitter()
    child.stdin.end = () => {}
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const signals: string[] = []
    child.kill = (signal: string) => {
      signals.push(signal)
      if (mode === 'term-zero' || mode === 'timeout-zero') child.emit('close', 0, null)
      return true
    }
    const timers: { callback: () => void; cleared: number; delay: number }[] = []
    await runTask(task, emitter, {
      spawn: (() => child) as any,
      executionIdentity: (() => ({})) as any,
      gitPull: () => {},
      gitCommit: () => { commits++; return 'sha' },
      setTimeout: ((callback: () => void, delay: number) => {
        const timer = { callback, cleared: 0, delay, unref() {} }
        timers.push(timer)
        return timer
      }) as any,
      clearTimeout: ((timer: any) => { timer.cleared++ }) as any,
    })
    assert.equal(countActiveProcs(), 1)
    if (mode === 'normal-race') {
      child.emit('close', 0, null)
      timers[0].callback() // Already queued timeout callback loses to close.
      assert.equal(killTask(task.id), false)
      assert.equal(commits, 1)
    } else {
      if (mode === 'spawn-error') {
        child.emit('error', new Error('fake spawn failure'))
      } else if ((mode === 'timeout' || mode === 'timeout-zero')) timers[0].callback()
      else {
        assert.equal(killTask(task.id), true)
        killTask(task.id) // Repeated requests must not send another SIGTERM.
      }
      if (mode !== 'term-zero' && mode !== 'timeout-zero') {
        assert.equal(countActiveProcs(), 1)
        assert.equal(countActiveTasks(), 1)
        assert.equal(getTask(task.id)?.status, 'running')
        assert.equal(getEmitter(task.id), emitter)
        assert.equal(done, 0)
        child.stdout.emit('data', Buffer.from('last output'))
        if (mode === 'exit-before-close') child.emit('exit', 0, null)
        if (mode !== 'spawn-error') timers[1].callback()
        child.emit('close', mode === 'exit-before-close' ? 0 : null, 'SIGKILL')
        assert.match(getTask(task.id)!.log, /last output/)
      }
      assert.equal(commits, 0)
      assert.equal(getTask(task.id)?.status, 'failed')
      assert.match(getTask(task.id)!.errorMessage!, mode.startsWith('timeout') ? /timed out/ : mode === 'spawn-error' ? /failed to launch claude/ : /cancelled/)
      assert.deepEqual(signals, mode === 'spawn-error' ? [] : mode === 'ignore' || mode === 'timeout' ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM'])
    }
    if (timers[1]) assert.equal(timers[1].delay, 10000)
    child.emit('close', 0, null) // Duplicate close never commits or completes twice.
    assert.equal(done, 1)
    assert.equal(events.filter(t => t === 'error' || t === 'complete').length, 1)
    assert.equal(countActiveProcs(), 0)
    assert.equal(countActiveTasks(), 0)
    assert.equal(getEmitter(task.id), undefined)
    assert.ok(timers.every(timer => timer.cleared === 1))
  })
}
