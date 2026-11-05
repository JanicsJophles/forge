import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { streamTask } from './task-stream.js'

class Socket extends EventEmitter {
  frames: string[] = []
  failAt = Infinity
  destroyed = false
  ended = false
  setHeader() {}
  flushHeaders() {}
  write(frame: string) {
    assert.equal(this.destroyed || this.ended, false, 'no write after closure')
    this.frames.push(frame)
    return this.frames.length < this.failAt
  }
  destroy() { this.destroyed = true; this.emit('close') }
  end() { this.ended = true; this.emit('close') }
}

function connect(emitter: EventEmitter | undefined, log = '', status: 'running' | 'completed' | 'failed' = 'running', failAt = Infinity) {
  const req = new EventEmitter()
  const res = new Socket()
  res.failAt = failAt
  streamTask(req as Request, res as unknown as Response, { log, status }, emitter)
  return { req, res }
}
function clean(req: EventEmitter, res: Socket, emitter?: EventEmitter) {
  assert.equal(req.listenerCount('close'), 0)
  assert.equal(res.listenerCount('close'), 0)
  assert.equal(res.listenerCount('error'), 0)
  assert.equal(emitter?.listenerCount('event') ?? 0, 0)
  assert.equal(emitter?.listenerCount('done') ?? 0, 0)
}

test('catch-up stops on first false write, including terminal tasks', () => {
  for (const status of ['running', 'completed', 'failed'] as const) {
    const emitter = new EventEmitter()
    const { req, res } = connect(emitter, 'x'.repeat(3_000_000), status, 2)
    assert.equal(res.frames.length, 2)
    assert.equal(res.destroyed, true)
    assert.ok(res.frames.every(frame => Buffer.byteLength(frame) < 12_400))
    clean(req, res, emitter)
    emitter.emit('event', { type: 'log', data: 'later' })
    emitter.emit('done')
    assert.equal(res.frames.length, 2)
  }
})

test('healthy reconnect reconstructs escaped Unicode catch-up and terminal framing', () => {
  const log = ('\u0000\n"\\' + 'x'.repeat(2042) + '😀').repeat(30)
  for (const status of ['completed', 'failed'] as const) {
    const { req, res } = connect(undefined, log, status)
    const frames = res.frames.slice(0, -1)
    assert.ok(frames.every(frame => Buffer.byteLength(frame) < 12_400))
    assert.equal(frames.map(frame => JSON.parse(frame.split('\ndata: ')[1])).join(''), log)
    assert.equal(res.frames.at(-1), `event: ${status === 'completed' ? 'complete' : 'error'}\ndata: ${JSON.stringify(status)}\n\n`)
    assert.equal(res.ended, true)
    clean(req, res)
  }
})

test('slow live subscriber cannot block healthy subscriber; all timers and listeners cleaned', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const emitter = new EventEmitter()
  const slow = connect(emitter, '', 'running', 2)
  const healthy = connect(emitter)
  emitter.emit('event', { type: 'log', data: 'x'.repeat(20_000) })
  assert.equal(slow.res.destroyed, true)
  assert.equal(slow.res.frames.length, 2)
  assert.ok(healthy.res.frames.length > 1)
  assert.equal(emitter.listenerCount('event'), 1)
  t.mock.timers.tick(15_000)
  assert.equal(healthy.res.frames.at(-1), ': ping\n\n')
  emitter.emit('event', { type: 'complete', data: 'completed' })
  emitter.emit('done')
  const count = healthy.res.frames.length
  t.mock.timers.tick(60_000)
  emitter.emit('event', { type: 'log', data: 'late' })
  assert.equal(healthy.res.frames.length, count)
  assert.equal(slow.res.frames.length, 2)
  assert.equal(healthy.res.ended, true)
  clean(slow.req, slow.res, emitter)
  clean(healthy.req, healthy.res, emitter)
})

test('disconnect, ping backpressure, status backpressure and missing emitter clean up', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  for (const cause of ['disconnect', 'ping', 'status', 'error']) {
    const emitter = new EventEmitter()
    const { req, res } = connect(emitter, '', 'running', 2)
    if (cause === 'disconnect') req.emit('close')
    if (cause === 'error') res.emit('error', new Error('socket closed'))
    if (cause === 'ping') t.mock.timers.tick(15_000)
    if (cause === 'status') emitter.emit('event', { type: 'error', data: 'failed' })
    clean(req, res, emitter)
    const count = res.frames.length
    t.mock.timers.tick(60_000)
    emitter.emit('event', { type: 'log', data: 'late' })
    emitter.emit('done')
    assert.equal(res.frames.length, count)
  }
  const missing = connect(undefined)
  assert.match(missing.res.frames[0], /^event: error/)
  assert.equal(missing.res.ended, true)
  clean(missing.req, missing.res)
  const terminal = connect(undefined, '', 'completed', 1)
  assert.equal(terminal.res.destroyed, true)
  clean(terminal.req, terminal.res)
})
