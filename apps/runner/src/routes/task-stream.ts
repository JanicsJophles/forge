import type { Request, Response } from 'express'
import type { AgentTask } from '@forge/shared'
import type { EventEmitter } from 'node:events'

// No application queue: one bounded frame may enter Node's response buffer.
// On backpressure destroy only this connection; never stall the task emitter.
export function streamTask(
  req: Request, res: Response, task: Pick<AgentTask, 'log' | 'status' | 'errorMessage'>,
  emitter?: EventEmitter, replay = true,
) {
  let closed = false
  let ping: ReturnType<typeof setInterval> | undefined
  function cleanup() {
    if (closed) return
    closed = true
    clearInterval(ping)
    emitter?.off('event', onEvent)
    emitter?.off('done', onDone)
    req.off('close', cleanup)
    res.off('close', cleanup)
    res.off('error', cleanup)
  }
  function write(frame: string): boolean {
    if (closed) return false
    try {
      if (res.write(frame)) return !closed
    } catch {
      // A broken socket must not throw through the shared task emitter.
    }
    cleanup()
    res.destroy()
    return false
  }
  function send(event: string, data: string): boolean {
    // Only logs are incremental. Other notifications are one semantic frame,
    // capped at 2048 UTF-16 code units including the truncation marker. Preserve
    // a useful prefix without splitting a surrogate pair; the task detail keeps
    // the full persisted diagnostic (this transport never mutates it).
    const chunkSize = 2048
    if (event !== 'log') {
      const marker = '… [truncated; see task detail]'
      if (data.length > chunkSize) {
        let end = chunkSize - marker.length
        if (/[\uD800-\uDBFF]/.test(data[end - 1])) end--
        data = data.slice(0, end) + marker
      }
      return write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    // JSON escaping expands each code unit by at most six bytes (~12 KiB).
    // Keep surrogate pairs together so concatenated log events round-trip.
    let offset = 0
    do {
      let end = Math.min(offset + chunkSize, data.length)
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--
      if (!write(`event: ${event}\ndata: ${JSON.stringify(data.slice(offset, end))}\n\n`)) return false
      offset = end
    } while (offset < data.length)
    return true
  }
  function onEvent(taskEvent: { type: string; data: string }) {
    send(taskEvent.type, taskEvent.data)
  }
  function onDone() {
    if (closed) return
    cleanup()
    res.end()
  }

  req.on('close', cleanup)
  res.on('close', cleanup)
  res.on('error', cleanup)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  // ?replay=0 opts out of the stored-log catch-up frame; status and all live
  // (and terminal) events below are still sent, so late consumers never hang.
  if (replay && task.log && !send('log', task.log)) return
  if (task.status === 'completed' || task.status === 'failed') {
    const data = task.status === 'failed' ? task.errorMessage ?? 'failed' : task.status
    if (send(task.status === 'completed' ? 'complete' : 'error', data)) onDone()
    return
  }
  if (!emitter) {
    if (send('error', 'task emitter not found — task may have crashed')) onDone()
    return
  }
  if (!send('status', task.status)) return
  emitter.on('event', onEvent)
  emitter.on('done', onDone)
  ping = setInterval(() => { write(': ping\n\n') }, 15_000)
}

