import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { AgentTask } from '@forge/shared'

const dir = mkdtempSync(join(tmpdir(), 'forge-output-'))
process.env.DATA_DIR = dir
process.env.ALLOWED_REPO_PATHS = dir
const { runTask, countActiveProcs } = await import('./runner.js')
const { insertTask, getTask } = await import('../db/queries.js')
const { createEmitter } = await import('./stream.js')
const { db } = await import('../db/schema.js')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const LIMIT = 16 * 1024

test('burst output is bounded, lossless, ordered, and flushed on timer and close', async () => {
  const task: AgentTask = { id: 'burst', repo: dir, branch: 'test', prompt: 'fake',
    status: 'queued', log: '', createdAt: new Date().toISOString(), autoCommit: false }
  insertTask(task)
  const emitter = createEmitter(task.id)
  const chunks: string[] = []
  const child = new EventEmitter() as any
  child.stdin = new EventEmitter()
  child.stdin.end = () => {}
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => assert.fail('output must not terminate child')
  await runTask(task, emitter, {
    spawn: (() => child) as any,
    executionIdentity: (() => ({})) as any,
    gitPull: () => {},
    gitCommit: () => assert.fail('autoCommit is disabled'),
    setTimeout, clearTimeout,
  })
  const initialLog = getTask(task.id)!.log
  let previousLog = initialLog
  emitter.on('event', event => {
    if (event.type !== 'log') return
    chunks.push(event.data)
    assert.ok(event.data.length <= LIMIT)
    // Every append reaches SQLite before its matching SSE event, at the same size.
    const stored = getTask(task.id)!.log
    assert.equal(stored, previousLog + event.data)
    previousLog = stored
    assert.ok(!/[\uD800-\uDBFF]$/.test(event.data))
    assert.ok(!/^[\uDC00-\uDFFF]/.test(event.data))
  })
  let expected = ''
  const send = (stream: 'stdout' | 'stderr', data: Buffer) => child[stream].emit('data', data)
  // One incoming chunk exceeds both the pending limit and the capture cap.
  const huge = 'x'.repeat(LIMIT - 1) + '😀漢字'.repeat(80000)
  send('stdout', Buffer.from(huge))
  expected += huge
  assert.ok(chunks.length > 16, 'burst must flush synchronously before the timer')
  const emoji = Buffer.from('🦊')
  send('stdout', emoji.subarray(0, 2))
  send('stdout', emoji.subarray(2))
  expected += '🦊'
  send('stderr', emoji.subarray(0, 1))
  send('stderr', emoji.subarray(1))
  expected += '[stderr] 🦊'
  send('stderr', Buffer.from('err'))
  send('stdout', Buffer.from('|out|'))
  send('stderr', Buffer.from('or\n\nnext\n' + 'a\n'.repeat(20000)))
  expected += 'err|out|or\n\n[stderr] next\n' + '[stderr] a\n'.repeat(20000)
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.equal(chunks.join(''), expected, 'timer drains the short remainder')
  const beforeClose = chunks.length
  send('stdout', Buffer.from('close:'))
  send('stdout', Buffer.from([0xe2, 0x82]))
  send('stderr', Buffer.from([0xf0, 0x9f]))
  assert.equal(chunks.length, beforeClose)
  child.emit('close', 0, null)
  expected += 'close:�[stderr] �'
  assert.equal(chunks.join(''), expected)
  assert.equal(getTask(task.id)!.log, initialLog + expected)
  assert.equal(getTask(task.id)!.status, 'completed')
  assert.equal(countActiveProcs(), 0)
})
