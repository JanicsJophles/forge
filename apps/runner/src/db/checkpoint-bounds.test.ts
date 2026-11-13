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

  // Internal scalar callers retain the established caps.
  const oversized = checkpoint({
    agentId: 'runaway',
    agentType: 'a'.repeat(1000),
    repo: 'r'.repeat(1000),
    branch: 'b'.repeat(1000),
    intent: 'i'.repeat(1000),
    ticket: 't'.repeat(1000),
    status: 's'.repeat(1000),
    filesTouched: ['unchanged.ts'],
  })

  assert.equal(oversized.agentType.length, CAP)
  assert.equal(oversized.repo!.length, CAP)
  assert.equal(oversized.branch!.length, CAP)
  assert.equal(oversized.intent!.length, CAP)
  assert.equal(oversized.ticket!.length, CAP)
  assert.equal(oversized.status!.length, CAP)
  assert.equal(oversized.intent, 'i'.repeat(CAP))
  assert.deepEqual(oversized.filesTouched, ['unchanged.ts'])
  const stored = listAgentState().find(row => row.agentId === 'runaway')!
  assert.deepEqual(stored, oversized)

  const before = listAgentState()
  for (const agentId of ['runaway', 'new-agent']) {
    assert.throws(() => checkpoint({
      agentId, intent: 'must not persist', filesTouched: ['x'.repeat(16381)],
    }), RangeError)
    assert.deepEqual(listAgentState(), before)
  }

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
