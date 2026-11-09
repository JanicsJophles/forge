import { Router } from 'express'
import type { Response } from 'express'
import { db } from '../db/schema.js'
import { MAX_LOG_SLICE_BYTES, readTaskLog, readTaskLogTail } from '../db/task-log.js'

export const taskLogRouter = Router()

// Send a {bytes, offset, nextOffset, totalBytes} slice as either the raw
// decoded text (format=text) or the default base64 JSON envelope. Both the
// byte-slice and line-tail readers return this shape, so they share this.
function sendSlice(
  res: Response,
  slice: { bytes: Buffer; offset: number; nextOffset: number; totalBytes: number },
  asText: boolean,
): void {
  if (asText) {
    res.setHeader('X-Total-Bytes', String(slice.totalBytes))
    res.setHeader('X-Next-Offset', String(slice.nextOffset))
    res.type('text/plain; charset=utf-8').send(slice.bytes)
    return
  }
  res.json({ data: slice.bytes.toString('base64'), offset: slice.offset,
    nextOffset: slice.nextOffset, totalBytes: slice.totalBytes })
}

taskLogRouter.get('/:id/log', (req, res) => {
  // Parse raw keys too: structured queries must fail even with a simple query parser.
  const query = new URL(req.originalUrl, 'http://localhost').searchParams
  function integer(name: string, fallback: number, minimum: number): number | undefined {
    const values = query.getAll(name)
    if ([...query.keys()].some(key => key.startsWith(name + '['))) return undefined
    if (values.length === 0) return fallback
    if (values.length !== 1 || !/^[0-9]+$/.test(values[0])) return undefined
    const value = Number(values[0])
    return Number.isSafeInteger(value) && value >= minimum ? value : undefined
  }
  // format selects the response encoding: absent => base64 JSON (default),
  // 'text' => the raw decoded bytes. Repeated/array/unknown values are rejected.
  const formats = query.getAll('format')
  const structuredFormat = [...query.keys()].some(key => key.startsWith('format['))
  if (structuredFormat || formats.length > 1 || (formats.length === 1 && formats[0] !== 'text')) {
    res.status(400).json({ error: "format must be omitted or 'text'" })
    return
  }
  const asText = formats[0] === 'text'
  // tailLines selects a line-oriented tail of the whole log. Precedence/coherence:
  //   - format applies to the tail output just as to a byte slice (text vs base64 JSON);
  //   - tailLines is mutually exclusive with the byte-slice params offset/limit —
  //     mixing a line tail with a byte window is incoherent, so reject with 400
  //     rather than silently returning the wrong data. When tailLines is absent
  //     the request falls through to the byte-slice path unchanged.
  // Fallback 0 is the "absent" sentinel (0 is itself rejected since minimum is 1).
  const tail = integer('tailLines', 0, 1)
  if (tail === undefined) {
    res.status(400).json({ error: 'tailLines must be a single positive safe integer' })
    return
  }
  if (tail > 0) {
    const sliceParamPresent = [...query.keys()].some(
      key => key === 'offset' || key === 'limit' || key.startsWith('offset[') || key.startsWith('limit['))
    if (sliceParamPresent) {
      res.status(400).json({ error: 'tailLines cannot be combined with offset or limit' })
      return
    }
    const tailSlice = readTaskLogTail(db, req.params.id, tail)
    if (!tailSlice) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    sendSlice(res, tailSlice, asText)
    return
  }
  const offset = integer('offset', 0, 0)
  const limit = integer('limit', MAX_LOG_SLICE_BYTES, 1)
  if (offset === undefined || limit === undefined || limit > MAX_LOG_SLICE_BYTES) {
    res.status(400).json({ error: 'offset must be a nonnegative safe integer; limit must be an integer from 1 to 262144' })
    return
  }
  const slice = readTaskLog(db, req.params.id, offset, limit)
  if (!slice) {
    res.status(404).json({ error: 'task not found' })
    return
  }
  sendSlice(res, slice, asText)
})
