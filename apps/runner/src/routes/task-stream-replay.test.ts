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
  setHeader() {}
  flushHeaders() {}
  write(frame: string) { this.frames.push(frame); return true }
  end() { this.ended = true; this.emit('close') }
  destroy() { this.destroyed = true; this.emit('close') }
}
const frame = (event: string, data: string) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
function connect(task: Pick<AgentTask, 'log' | 'status' | 'errorMessage'>, emitter: EventEmitter | undefined, replay: boolean) {
  const req = new EventEmitter()
  const res = new Socket()
  streamTask(req as Request, res as unknown as Response, task, emitter, replay)
  return { req, res }
}
function clean(req: EventEmitter, res: Socket, emitter?: EventEmitter) {
  assert.equal(req.listenerCount('close'), 0)
  assert.equal(res.listenerCount('close'), 0)
  assert.equal(res.listenerCount('error'), 0)
  assert.equal(emitter?.listenerCount('event') ?? 0, 0)
  assert.equal(emitter?.listenerCount('done') ?? 0, 0)
}

test('replay=0 suppresses the stored-log catch-up frame but keeps status and live events', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const emitter = new EventEmitter()
  const { req, res } = connect({ log: 'saved log', status: 'running' }, emitter, false)
  // No initial 'log' frame — only the current status.
  assert.deepEqual(res.frames, [frame('status', 'running')])
  emitter.emit('event', { type: 'log', data: 'live log' })
  assert.deepEqual(res.frames, [frame('status', 'running'), frame('log', 'live log')])
  emitter.emit('done')
  assert.equal(res.ended, true)
  clean(req, res, emitter)
  t.mock.timers.tick(60_000)
  assert.equal(res.frames.length, 2)
})

test('replay=1 (default) still replays the stored log before the status', () => {
  const emitter = new EventEmitter()
  const { req, res } = connect({ log: 'saved log', status: 'running' }, emitter, true)
  assert.deepEqual(res.frames, [frame('log', 'saved log'), frame('status', 'running')])
  emitter.emit('done')
  clean(req, res, emitter)
})

test('replay=0 on a completed task skips the log yet still sends the terminal event and ends', () => {
  const { req, res } = connect({ log: 'saved log', status: 'completed' }, undefined, false)
  assert.deepEqual(res.frames, [frame('complete', 'completed')])
  assert.equal(res.ended, true)
  clean(req, res)
})

test('replay=0 on a failed task skips the log yet still sends the saved error reason and ends', () => {
  const { req, res } = connect({ log: 'saved log', status: 'failed', errorMessage: 'boom' }, undefined, false)
  assert.deepEqual(res.frames, [frame('error', 'boom')])
  assert.equal(res.ended, true)
  clean(req, res)
})
