import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import type { AgentTask } from '@forge/shared'
import { streamTask } from './task-stream.js'

class Socket extends EventEmitter {
  frames: string[] = []
  ended = false
  destroyed = false
  failAt = Infinity
  setHeader() {}
  flushHeaders() {}
  write(frame: string) { this.frames.push(frame); return this.frames.length < this.failAt }
  end() { this.ended = true; this.emit('close') }
  destroy() { this.destroyed = true; this.emit('close') }
}
const frame = (event: string, data: string) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
function connect(task: Pick<AgentTask, 'log' | 'status' | 'errorMessage'>, emitter?: EventEmitter, failAt = Infinity) {
  const req = new EventEmitter()
  const res = new Socket()
  res.failAt = failAt
  streamTask(req as Request, res as unknown as Response, task, emitter)
  return { req, res }
}
function clean(req: EventEmitter, res: Socket, emitter?: EventEmitter) {
  assert.equal(req.listenerCount('close'), 0)
  assert.equal(res.listenerCount('close'), 0)
  assert.equal(res.listenerCount('error'), 0)
  assert.equal(emitter?.listenerCount('event') ?? 0, 0)
  assert.equal(emitter?.listenerCount('done') ?? 0, 0)
}

const marker = '… [truncated; see task detail]'
const prefixLimit = 2048 - marker.length
const decode = (frame: string): string => JSON.parse(frame.split('\ndata: ')[1])

for (const reason of [
  'provider failed: ' + 'x'.repeat(20_000),
  '\u0000'.repeat(20_000),
  'x'.repeat(prefixLimit - 1) + '😀' + 'z'.repeat(3000),
]) {
  test(`stored long error is one bounded frame with full detail preserved (${reason.charCodeAt(0)})`, () => {
    const task = { status: 'failed' as const, errorMessage: reason, log: '' }
    const { req, res } = connect(task)
    assert.equal(res.frames.length, 1)
    assert.match(res.frames[0], /^event: error\n/)
    const diagnostic = decode(res.frames[0])
    assert.ok(diagnostic.endsWith(marker))
    assert.ok(reason.startsWith(diagnostic.slice(0, -marker.length)))
    assert.ok(diagnostic.length <= 2048)
    assert.ok(Buffer.byteLength(res.frames[0]) < 12_400)
    assert.equal(diagnostic.includes('\uFFFD'), false)
    assert.equal(/[\uD800-\uDBFF]$/.test(diagnostic.slice(0, -marker.length)), false)
    assert.equal(task.errorMessage, reason)
    assert.equal(res.ended, true)
    clean(req, res)
  })
}

test('live errors and completion stay atomic, then done ends and cleans the stream', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  for (const type of ['error', 'complete', 'status']) {
    const emitter = new EventEmitter()
    const { req, res } = connect({ log: '', status: 'running' }, emitter)
    const data = 'x'.repeat(prefixLimit - 1) + '😀' + 'z'.repeat(10_000)
    emitter.emit('event', { type, data })
    assert.equal(res.frames.length, 2)
    assert.equal(res.frames[1], frame(type, 'x'.repeat(prefixLimit - 1) + marker))
    emitter.emit('done')
    assert.equal(res.ended, true)
    clean(req, res, emitter)
    t.mock.timers.tick(60_000)
    emitter.emit('event', { type: 'error', data: 'late' })
    assert.equal(res.frames.length, 2)
  }
})

test('non-log payload at the limit remains unchanged, including Unicode', () => {
  const reason = 'x'.repeat(2046) + '😀'
  const { req, res } = connect({ log: '', status: 'failed', errorMessage: reason })
  assert.deepEqual(res.frames, [frame('error', reason)])
  clean(req, res)
})

test('slow live terminal consumer disconnects after one bounded frame without leaking listeners', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const emitter = new EventEmitter()
  const { req, res } = connect({ log: '', status: 'running' }, emitter, 2)
  emitter.emit('event', { type: 'error', data: '\u0000'.repeat(50_000) })
  assert.equal(res.frames.length, 2)
  assert.ok(Buffer.byteLength(res.frames[1]) < 12_400)
  assert.equal(res.destroyed, true)
  assert.equal(res.ended, false)
  clean(req, res, emitter)
  emitter.emit('done')
  t.mock.timers.tick(60_000)
  assert.equal(res.frames.length, 2)
})
