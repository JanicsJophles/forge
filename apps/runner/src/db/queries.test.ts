import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTask } from '@forge/shared'

// schema.ts opens the SQLite DB at import time using DATA_DIR, so point it at a
// scratch directory before the module graph loads.
let dataDir: string
let queries: typeof import('./queries.js')

function makeTask(over: Partial<AgentTask>): AgentTask {
  return {
    id: over.id ?? crypto.randomUUID(),
    provider: 'claude',
    repo: '/tmp/repo',
    branch: 'main',
    prompt: 'do a thing',
    status: 'completed',
    log: '',
    createdAt: new Date().toISOString(),
    ...over,
  }
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'forge-db-'))
  process.env.DATA_DIR = dataDir
  queries = await import('./queries.js')
})

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

test('readOnly round-trips through insert and getTask', () => {
  const ro = makeTask({ readOnly: true })
  const rw = makeTask({ readOnly: false })
  queries.insertTask(ro)
  queries.insertTask(rw)
  assert.equal(queries.getTask(ro.id)?.readOnly, true)
  assert.equal(queries.getTask(rw.id)?.readOnly, false)
})

test('autoCommit round-trips independently of readOnly', () => {
  const t = makeTask({ autoCommit: false, readOnly: true })
  queries.insertTask(t)
  const got = queries.getTask(t.id)
  assert.equal(got?.autoCommit, false)
  assert.equal(got?.readOnly, true)
})

test('listTasks caps each log to the trailing bytes, getTask keeps the full log', () => {
  const big = 'A'.repeat(10_000) + 'TAIL'
  const t = makeTask({ id: 'big-log-task', log: big })
  queries.insertTask(t)

  const listed = queries.listTasks(20, queries.LIST_LOG_TAIL_BYTES).find(x => x.id === t.id)
  assert.ok(listed)
  assert.equal(listed.log.length, queries.LIST_LOG_TAIL_BYTES)
  assert.ok(listed.log.endsWith('TAIL'), 'truncation keeps the tail of the log')
  assert.equal(listed.log_truncated, true, 'a capped row is flagged log_truncated')

  const full = queries.getTask(t.id)
  assert.equal(full?.log.length, big.length, 'getTask returns the untruncated log')
})

test('listTasks without a cap returns the full log', () => {
  const big = 'B'.repeat(8000)
  const t = makeTask({ id: 'uncapped-task', log: big })
  queries.insertTask(t)
  const listed = queries.listTasks(20).find(x => x.id === t.id)
  assert.equal(listed?.log.length, big.length)
})

test('listTasks cap is a no-op for short logs', () => {
  const t = makeTask({ id: 'short-log-task', log: 'short' })
  queries.insertTask(t)
  const listed = queries.listTasks(20, queries.LIST_LOG_TAIL_BYTES).find(x => x.id === t.id)
  assert.equal(listed?.log, 'short')
  assert.equal(listed?.log_truncated, undefined, 'an uncapped row carries no truncation flag')
})
