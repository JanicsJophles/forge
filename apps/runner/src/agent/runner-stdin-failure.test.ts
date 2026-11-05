import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { AgentTask } from '@forge/shared'

const dir = mkdtempSync(join(tmpdir(), 'forge-stdin-'))
process.env.DATA_DIR = dir
process.env.ALLOWED_REPO_PATHS = dir
const { runTask, killTask, countActiveProcs } = await import('./runner.js')
const { insertTask, getTask, countActiveTasks } = await import('../db/queries.js')
const { createEmitter, getEmitter } = await import('./stream.js')
const { db } = await import('../db/schema.js')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

for (const mode of ['epipe', 'callback', 'throw', 'throw-immediate-close', 'normal',
  'cancel-first', 'failure-first', 'exit-first', 'close-first', 'timeout-first'] as const) {
  test(`Codex stdin: ${mode}`, async () => {
    const secret = 'private prompt and raw error detail'
    const failure = Object.assign(new Error(secret), { code: 'EPIPE' })
    const task: AgentTask = { id: mode, repo: dir, branch: 'test', prompt: secret,
      provider: 'codex', status: 'queued', log: '', createdAt: new Date().toISOString(), autoCommit: true }
    insertTask(task)
    const emitter = createEmitter(task.id)
    const events: { type: string; data: string }[] = []
    let done = 0
    let commits = 0
    emitter.on('event', event => events.push(event))
    emitter.on('done', () => done++)
    const child = new EventEmitter() as any
    child.stdin = new EventEmitter()
    let writeDone: (error?: Error | null) => void = () => assert.fail('missing write callback')
    child.stdin.end = (prompt: string, callback: typeof writeDone) => {
      assert.equal(prompt, secret)
      writeDone = callback
      if (mode.startsWith('throw')) throw failure
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const signals: string[] = []
    child.kill = (signal: string) => {
      signals.push(signal)
      if (mode === 'throw-immediate-close') child.emit('close', 0, null)
      return true
    }
    const timers: { callback: () => void; cleared: number }[] = []
    await runTask(task, emitter, {
      spawn: (() => child) as any,
      executionIdentity: (() => ({})) as any,
      checkCodexLogin: async () => {},
      gitPull: () => {},
      gitCommit: () => { commits++; return 'sha' },
      setTimeout: ((callback: () => void) => {
        const timer = { callback, cleared: 0, unref() {} }
        timers.push(timer)
        return timer
      }) as any,
      clearTimeout: ((timer: any) => { timer.cleared++ }) as any,
    })
    if (mode === 'normal') writeDone()
    else if (mode === 'cancel-first') killTask(task.id)
    else if (mode === 'timeout-first') timers[0].callback()
    else if (mode === 'exit-first') child.emit('exit', 1, null)
    else if (mode === 'close-first') child.emit('close', 0, null)
    else if (mode === 'callback') writeDone(failure)
    else if (!mode.startsWith('throw')) child.stdin.emit('error', failure)

    if (mode === 'failure-first') killTask(task.id)
    if (mode !== 'normal') {
      // Error and callback can both report the same failure, even after close.
      child.stdin.emit('error', failure)
      writeDone(failure)
    }
    if (mode !== 'throw-immediate-close' && mode !== 'close-first') {
      assert.equal(countActiveProcs(), 1)
      assert.equal(countActiveTasks(), 1)
      assert.equal(getTask(task.id)?.status, 'running')
      assert.equal(getEmitter(task.id), emitter)
      assert.equal(done, 0)
    }
    child.emit('close', mode === 'exit-first' ? 1 : 0, null)
    child.emit('close', 0, null)
    child.stdin.emit('error', failure)
    timers.forEach(timer => timer.callback()) // Stale callbacks cannot signal again.
    const success = mode === 'normal' || mode === 'close-first'
    const stored = getTask(task.id)!
    assert.equal(stored.status, success ? 'completed' : 'failed')
    assert.equal(commits, success ? 1 : 0)
    assert.equal(events.filter(e => e.type === 'complete').length, success ? 1 : 0)
    assert.equal(events.filter(e => e.type === 'error').length, success ? 0 : 1)
    if (!success) {
      assert.match(stored.errorMessage!, mode === 'cancel-first' ? /cancelled/
        : mode === 'timeout-first' ? /timed out/
        : mode === 'exit-first' ? /exited/ : /prompt delivery failed/)
      if (mode === 'cancel-first' || mode === 'timeout-first' || mode === 'exit-first') {
        assert.ok(!stored.errorMessage!.includes('prompt delivery failed'))
      }
    }
    assert.deepEqual(signals, success || mode === 'exit-first' ? [] : ['SIGTERM'])
    assert.ok(!stored.log.includes(secret))
    assert.ok(!stored.errorMessage?.includes(secret))
    assert.ok(events.every(e => !e.data.includes(secret)))
    assert.equal(done, 1)
    assert.equal(countActiveProcs(), 0)
    assert.equal(countActiveTasks(), 0)
    assert.equal(getEmitter(task.id), undefined)
    assert.ok(timers.every(timer => timer.cleared === 1))
  })
}
