import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'forge-board-sync-'))
const { db } = await import('./schema.js')
const { checkpoint, listAgentState, listEvents } = await import('./agent-state.js')
const { insertTask, updateTaskStatus } = await import('./queries.js')
const { reconcileBoard, boardAgentId } = await import('./board-sync.js')

function addTask(id: string, status = 'queued'): void {
  insertTask({
    id, repo: '/opt/repos/x', branch: 'b', prompt: 'p', status: status as 'queued',
    log: '', createdAt: new Date().toISOString(),
  })
}

function register(id: string): void {
  checkpoint({ agentId: boardAgentId(id), agentType: 'forge', repo: 'x', status: 'running', ttlSeconds: 18000 })
}

const liveIds = (): string[] => listAgentState({}).map(a => a.agentId)

test('completing a task takes its board entry out of running and emits an event', () => {
  addTask('t-done')
  register('t-done')
  updateTaskStatus('t-done', 'running')
  assert.ok(liveIds().includes(boardAgentId('t-done')))

  updateTaskStatus('t-done', 'completed')

  assert.ok(!liveIds().includes(boardAgentId('t-done')))
  const entry = listAgentState({ includeExpired: true }).find(a => a.agentId === boardAgentId('t-done'))
  assert.equal(entry?.status, 'completed')
  const events = listEvents({ eventType: 'task_completed' })
  assert.equal(events.filter(e => e.agentId === boardAgentId('t-done')).length, 1)
})

test('failed tasks settle as failed; tasks without a board entry are a no-op', () => {
  addTask('t-fail')
  register('t-fail')
  updateTaskStatus('t-fail', 'failed')
  const entry = listAgentState({ includeExpired: true }).find(a => a.agentId === boardAgentId('t-fail'))
  assert.equal(entry?.status, 'failed')

  addTask('t-nobody')
  updateTaskStatus('t-nobody', 'completed')
  assert.ok(!listAgentState({ includeExpired: true }).some(a => a.agentId === boardAgentId('t-nobody')))
})

test('reconcile clears ghosts for terminal and missing tasks, keeps live ones, is idempotent', () => {
  addTask('g-verified', 'queued')
  addTask('g-capped', 'queued')
  addTask('g-live', 'queued')
  for (const id of ['g-verified', 'g-capped', 'g-live', 'g-missing-old', 'g-missing-new']) register(id)
  // Simulate terminal states reached without the hook (crash, legacy runner).
  db.prepare("UPDATE tasks SET status = 'verified' WHERE id = 'g-verified'").run()
  db.prepare("UPDATE tasks SET status = 'capped' WHERE id = 'g-capped'").run()
  db.prepare("UPDATE tasks SET status = 'running' WHERE id = 'g-live'").run()
  db.prepare("UPDATE agent_state SET updated_at = datetime('now', '-1 hours') WHERE agent_id = ?")
    .run(boardAgentId('g-missing-old'))

  assert.equal(reconcileBoard(), 3)

  const byId = new Map(listAgentState({ includeExpired: true }).map(a => [a.agentId, a.status]))
  assert.equal(byId.get(boardAgentId('g-verified')), 'verified')
  assert.equal(byId.get(boardAgentId('g-capped')), 'capped')
  assert.equal(byId.get(boardAgentId('g-missing-old')), 'missing')
  assert.equal(byId.get(boardAgentId('g-live')), 'running')
  assert.equal(byId.get(boardAgentId('g-missing-new')), 'running')
  const live = liveIds()
  assert.ok(live.includes(boardAgentId('g-live')))
  assert.ok(!live.includes(boardAgentId('g-verified')))

  assert.equal(reconcileBoard(), 0)
})
