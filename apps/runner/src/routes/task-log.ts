import { Router } from 'express'
import { db } from '../db/schema.js'
import { MAX_LOG_SLICE_BYTES, readTaskLog } from '../db/task-log.js'

export const taskLogRouter = Router()

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
  if (asText) {
    res.setHeader('X-Total-Bytes', String(slice.totalBytes))
    res.setHeader('X-Next-Offset', String(slice.nextOffset))
    res.type('text/plain; charset=utf-8').send(slice.bytes)
    return
  }
  res.json({ data: slice.bytes.toString('base64'), offset: slice.offset,
    nextOffset: slice.nextOffset, totalBytes: slice.totalBytes })
})
