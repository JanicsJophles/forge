import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// schema.ts opens DATA_DIR/forge.db at import time, so point it at a scratch dir first.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'forge-board-sync-'))
const { db } = await import('./schema.js')
const { checkpoint, listAgentState, listEvents } = await import('./agent-state.js')
const { insertTask, updateTaskStatus } = await import('./queries.js')
const { reconcileBoard, settleBoardEntry, boardAgentId } = await import('./board-sync.js')

function addTask(id: string): void {
  insertTask({
    id, repo: '/opt/repos/x', branch: 'b', prompt: 'p', status: 'queued',
    log: '', createdAt: new Date().toISOString(),
  })
}

function register(id: string, status = 'running'): void {
  checkpoint({ agentId: boardAgentId(id), agentType: 'forge', repo: 'x', status, ttlSeconds: 18000 })
}

// Simulate a state reached without the hook (crash, legacy runner, boot-time zombie sweep).
function forceTask(id: string, status: string, completedAt = "datetime('now')"): void {
  db.prepare(`UPDATE tasks SET status = ?, completed_at = ${completedAt} WHERE id = ?`).run(status, id)
}

const liveIds = (): string[] => listAgentState({}).map(a => a.agentId)
const boardStatus = (id: string): string | null | undefined =>
  listAgentState({ includeExpired: true }).find(a => a.agentId === boardAgentId(id))?.status
const eventsFor = (id: string): string[] =>
  listEvents({ limit: 1000 }).filter(e => e.agentId === boardAgentId(id)).map(e => e.eventType)

test('completing a task takes its board entry out of running and emits one event', () => {
  addTask('t-done')
  register('t-done')
  updateTaskStatus('t-done', 'running')
  assert.ok(liveIds().includes(boardAgentId('t-done')))

  updateTaskStatus('t-done', 'completed')

  assert.ok(!liveIds().includes(boardAgentId('t-done')))
  assert.equal(boardStatus('t-done'), 'completed')
  assert.deepEqual(eventsFor('t-done'), ['task_completed'])
})

test('failed tasks settle as failed; a task with no board entry is a no-op', () => {
  addTask('t-fail')
  register('t-fail')
  updateTaskStatus('t-fail', 'failed')
  assert.equal(boardStatus('t-fail'), 'failed')
  assert.deepEqual(eventsFor('t-fail'), ['task_failed'])

  addTask('t-nobody')
  updateTaskStatus('t-nobody', 'completed')
  assert.equal(boardStatus('t-nobody'), undefined)
  assert.deepEqual(eventsFor('t-nobody'), [])
})

test('settling is idempotent and never overwrites a client verdict', () => {
  addTask('t-twice')
  register('t-twice')
  updateTaskStatus('t-twice', 'completed')
  assert.equal(settleBoardEntry('t-twice', 'completed'), false)
  assert.equal(settleBoardEntry('t-twice', 'failed'), false)
  assert.equal(boardStatus('t-twice'), 'completed')
  assert.deepEqual(eventsFor('t-twice'), ['task_completed'])

  // The dispatcher checkpoints `verified` after the runner settled the entry.
  register('t-twice', 'verified')
  assert.equal(reconcileBoard(), 0)
  assert.equal(boardStatus('t-twice'), 'verified')
  assert.ok(!liveIds().includes(boardAgentId('t-twice')))
})

test('client terminal statuses are not live even before their TTL lapses', () => {
  for (const status of ['verified', 'done', 'aborted', 'missing']) {
    checkpoint({ agentId: `local-${status}`, agentType: 'claude', status, ttlSeconds: 18000 })
  }
  checkpoint({ agentId: 'local-editing', agentType: 'claude', status: 'editing', ttlSeconds: 18000 })
  checkpoint({ agentId: 'local-nostatus', agentType: 'claude', ttlSeconds: 18000 })
  const live = liveIds()
  for (const status of ['verified', 'done', 'aborted', 'missing']) assert.ok(!live.includes(`local-${status}`))
  assert.ok(live.includes('local-editing'))
  assert.ok(live.includes('local-nostatus'))
})

test('reconcile clears ghosts for terminal and missing tasks, keeps live ones, is idempotent', () => {
  for (const id of ['g-recent', 'g-old', 'g-failed', 'g-live', 'g-queued']) addTask(id)
  for (const id of ['g-recent', 'g-old', 'g-failed', 'g-live', 'g-queued', 'g-missing-old', 'g-missing-new']) register(id)
  forceTask('g-recent', 'completed')
  forceTask('g-old', 'completed', "datetime('now', '-2 days')")
  forceTask('g-failed', 'failed')
  forceTask('g-live', 'running', 'NULL')
  db.prepare("UPDATE agent_state SET updated_at = datetime('now', '-1 hours') WHERE agent_id = ?")
    .run(boardAgentId('g-missing-old'))
  // A ghost whose TTL already lapsed still gets its real status.
  db.prepare("UPDATE agent_state SET expires_at = datetime('now', '-3 hours') WHERE agent_id = ?")
    .run(boardAgentId('g-old'))

  assert.equal(reconcileBoard(), 4)

  assert.equal(boardStatus('g-recent'), 'completed')
  assert.equal(boardStatus('g-old'), 'completed')
  assert.equal(boardStatus('g-failed'), 'failed')
  assert.equal(boardStatus('g-missing-old'), 'missing')
  assert.equal(boardStatus('g-live'), 'running')
  assert.equal(boardStatus('g-queued'), 'running')
  assert.equal(boardStatus('g-missing-new'), 'running')
  const live = liveIds()
  for (const id of ['g-live', 'g-queued', 'g-missing-new']) assert.ok(live.includes(boardAgentId(id)))
  for (const id of ['g-recent', 'g-old', 'g-failed', 'g-missing-old']) assert.ok(!live.includes(boardAgentId(id)))

  // Only tasks that ended inside the replay window are announced.
  assert.deepEqual(eventsFor('g-recent'), ['task_completed'])
  assert.deepEqual(eventsFor('g-failed'), ['task_failed'])
  assert.deepEqual(eventsFor('g-old'), [])
  assert.deepEqual(eventsFor('g-missing-old'), [])

  assert.equal(reconcileBoard(), 0)
  assert.deepEqual(eventsFor('g-recent'), ['task_completed'])
})

test('an entry that is not a forge task is never touched by reconcile', () => {
  checkpoint({ agentId: 'claude-local-1', agentType: 'claude', status: 'running', ttlSeconds: 18000 })
  db.prepare("UPDATE agent_state SET updated_at = datetime('now', '-1 days') WHERE agent_id = 'claude-local-1'").run()
  assert.equal(reconcileBoard(), 0)
  assert.ok(liveIds().includes('claude-local-1'))
})
