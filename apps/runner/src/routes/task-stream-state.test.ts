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

test('queued and running reconnects replay log then current status exactly once before live events', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  for (const status of ['queued', 'running'] as const) {
    const emitter = new EventEmitter()
    const { req, res } = connect({ log: 'saved log', status }, emitter)
    assert.deepEqual(res.frames, [frame('log', 'saved log'), frame('status', status)])
    assert.equal(res.ended, false)
    emitter.emit('event', { type: 'log', data: 'live log' })
    assert.deepEqual(res.frames, [frame('log', 'saved log'), frame('status', status), frame('log', 'live log')])
    emitter.emit('done')
    clean(req, res, emitter)
    t.mock.timers.tick(60_000)
    assert.equal(res.frames.length, 3)
    assert.equal(res.ended, true)
  }
})

test('terminal reconnects preserve completion and saved failure reasons, including legacy fallback', () => {
  for (const task of [
    { status: 'completed', errorMessage: 'ignored' },
    { status: 'failed', errorMessage: 'provider exited\nwith code 1' },
    { status: 'failed' },
  ] as const) {
    const emitter = new EventEmitter()
    const { req, res } = connect({ log: 'saved log', ...task }, emitter)
    const data = task.status === 'completed' ? 'completed' : ('errorMessage' in task ? task.errorMessage : 'failed')
    assert.deepEqual(res.frames, [frame('log', 'saved log'), frame(task.status === 'completed' ? 'complete' : 'error', data)])
    assert.equal(res.ended, true)
    clean(req, res, emitter)
  }
})

test('missing emitter reports error after catch-up and closes queued and running streams', () => {
  for (const status of ['queued', 'running'] as const) {
    const { req, res } = connect({ log: 'saved log', status })
    assert.deepEqual(res.frames, [frame('log', 'saved log'), frame('error', 'task emitter not found — task may have crashed')])
    assert.equal(res.ended, true)
    clean(req, res)
  }
})

test('backpressure on initial status destroys connection without listeners or ping timer', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const emitter = new EventEmitter()
  const { req, res } = connect({ log: 'saved log', status: 'queued' }, emitter, 2)
  assert.equal(res.destroyed, true)
  clean(req, res, emitter)
  t.mock.timers.tick(60_000)
  emitter.emit('event', { type: 'log', data: 'late' })
  assert.equal(res.frames.length, 2)
})
