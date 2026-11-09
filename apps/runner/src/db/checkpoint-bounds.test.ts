import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('checkpoint caps oversized fields while round-tripping small values', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'forge-checkpoint-bounds-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = dataDir
  const { db } = await import('./schema.js')
  const { checkpoint, listAgentState } = await import('./agent-state.js')
  t.after(() => {
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    rmSync(dataDir, { recursive: true, force: true })
  })

  const CAP = 500
  const MAX_FILES = 200

  // Over-long strings in every bounded field + an over-count, over-long
  // filesTouched array. A valid checkpoint must still succeed (surplus dropped,
  // not rejected).
  const oversized = checkpoint({
    agentId: 'runaway',
    agentType: 'a'.repeat(1000),
    repo: 'r'.repeat(1000),
    branch: 'b'.repeat(1000),
    intent: 'i'.repeat(1000),
    ticket: 't'.repeat(1000),
    status: 's'.repeat(1000),
    filesTouched: Array.from({ length: 1000 }, (_, n) => `file-${n}-` + 'x'.repeat(1000)),
  })

  assert.equal(oversized.agentType.length, CAP)
  assert.equal(oversized.repo!.length, CAP)
  assert.equal(oversized.branch!.length, CAP)
  assert.equal(oversized.intent!.length, CAP)
  assert.equal(oversized.ticket!.length, CAP)
  assert.equal(oversized.status!.length, CAP)
  assert.equal(oversized.intent, 'i'.repeat(CAP))
  assert.equal(oversized.filesTouched!.length, MAX_FILES)
  assert.ok(oversized.filesTouched!.every(f => f.length <= CAP))
  // Surplus entries are dropped (truncation keeps the head of the array).
  assert.ok(oversized.filesTouched![0].startsWith('file-0-'))
  assert.ok(oversized.filesTouched![MAX_FILES - 1].startsWith(`file-${MAX_FILES - 1}-`))

  // The capped row persists and re-reads identically through listAgentState.
  const stored = listAgentState().find(row => row.agentId === 'runaway')!
  assert.equal(stored.intent!.length, CAP)
  assert.equal(stored.filesTouched!.length, MAX_FILES)

  // A normal small checkpoint round-trips unchanged.
  const small = {
    agentId: 'normal',
    agentType: 'forge',
    repo: 'forge',
    branch: 'fleet/forge/test',
    intent: 'doing a thing',
    ticket: 'FORGE-1',
    status: 'editing',
    filesTouched: ['apps/runner/src/index.ts', 'README.md'],
  }
  const normal = checkpoint(small)
  assert.equal(normal.agentType, small.agentType)
  assert.equal(normal.repo, small.repo)
  assert.equal(normal.branch, small.branch)
  assert.equal(normal.intent, small.intent)
  assert.equal(normal.ticket, small.ticket)
  assert.equal(normal.status, small.status)
  assert.deepEqual(normal.filesTouched, small.filesTouched)

  // Boundary: exactly CAP chars and exactly MAX_FILES entries are untouched.
  const exact = checkpoint({
    agentId: 'exact',
    intent: 'e'.repeat(CAP),
    filesTouched: Array.from({ length: MAX_FILES }, (_, n) => `f${n}`),
  })
  assert.equal(exact.intent, 'e'.repeat(CAP))
  assert.equal(exact.filesTouched!.length, MAX_FILES)
})
