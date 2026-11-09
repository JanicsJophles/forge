import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import type { AgentTask } from '@forge/shared'
import { streamTask } from './task-stream.js'
import { LOG_TAIL_BYTES } from '../db/task-projection.js'

const MARKER = '… [earlier output truncated]\n'
// Concatenate the payloads of the leading run of 'log' frames back into one string
// (send() chunks a long log into many 2048-unit frames before the status frame).
function replayedLog(frames: string[]): string {
  let out = ''
  for (const f of frames) {
    const m = /^event: log\ndata: (.*)\n\n$/s.exec(f)
    if (!m) break
    out += JSON.parse(m[1])
  }
  return out
}

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

test('a log within LOG_TAIL_BYTES replays verbatim with no truncation marker', () => {
  const emitter = new EventEmitter()
  const log = 'x'.repeat(LOG_TAIL_BYTES)
  const { req, res } = connect({ log, status: 'running' }, emitter, true)
  const replayed = replayedLog(res.frames)
  assert.equal(replayed, log)
  assert.equal(replayed.includes(MARKER), false)
  assert.equal(res.frames.at(-1), frame('status', 'running'))
  emitter.emit('done')
  clean(req, res, emitter)
})

test('an over-bound log replays only the trailing LOG_TAIL_BYTES plus a truncation marker', () => {
  const emitter = new EventEmitter()
  const tail = 'y'.repeat(LOG_TAIL_BYTES)
  const log = 'HEAD-DROPPED' + tail
  const { req, res } = connect({ log, status: 'running' }, emitter, true)
  const replayed = replayedLog(res.frames)
  assert.equal(replayed, MARKER + tail)
  assert.equal(replayed.includes('HEAD-DROPPED'), false)
  // Only the bounded tail (plus marker) is replayed, never the full blob.
  assert.equal(replayed.length, MARKER.length + LOG_TAIL_BYTES)
  // Live events after the replay are unaffected.
  emitter.emit('event', { type: 'log', data: 'live' })
  assert.equal(res.frames.at(-1), frame('log', 'live'))
  emitter.emit('done')
  clean(req, res, emitter)
})

test('truncation never begins on a split surrogate pair', () => {
  const emitter = new EventEmitter()
  // Lay out log so the LOG_TAIL_BYTES boundary lands exactly on the low surrogate of
  // a 😀 (U+1F600 = \uD83D\uDE00): length is 2*LOG_TAIL_BYTES, so start = LOG_TAIL_BYTES
  // points at the orphaned low surrogate. A naive slice would emit a lone surrogate.
  const log = 'z'.repeat(LOG_TAIL_BYTES - 1) + '😀' + 'z'.repeat(LOG_TAIL_BYTES - 1)
  const { req, res } = connect({ log, status: 'running' }, emitter, true)
  const replayed = replayedLog(res.frames).slice(MARKER.length)
  // The orphaned low surrogate is dropped: the tail is clean z's only.
  assert.equal(/[\uD800-\uDFFF]/.test(replayed), false)
  assert.equal(replayed, 'z'.repeat(LOG_TAIL_BYTES - 1))
  emitter.emit('done')
  clean(req, res, emitter)
})
