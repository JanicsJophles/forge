// One runner start against DATA_DIR/forge.db, for the upgrade rehearsal.
//
// Importing schema.js and agent-state.js runs the same bootstrap the service
// runs at boot (index.ts imports them for their side effects). The read probes
// then push pre-upgrade rows through the public query functions, so a row the
// new code cannot read fails here instead of on a dashboard after a deploy.
import { performance } from 'node:perf_hooks'
import { PROBE_EVENT_LIMIT, PROBE_MARKER, PROBE_TASK_LIMIT, type StartProbe } from './upgrade-rehearsal.js'

const startedAt = performance.now()
const { db } = await import('./schema.js')
const { listAgentState, listEvents, getAgentState } = await import('./agent-state.js')
const bootstrapMs = Math.round(performance.now() - startedAt)

const { getTask, listTasks, listActiveTasks, countActiveTasks, oldestRunningTaskAgeSeconds } = await import('./queries.js')
const { readTaskProjection } = await import('./task-projection.js')

const tasks = listTasks(PROBE_TASK_LIMIT)
let readTasks = 0
for (const task of tasks) {
  // Full row, then both API projections: every listed task must stay readable.
  if (!getTask(task.id)) throw new Error('listed task is not readable by id')
  if (!readTaskProjection(db, task.id, 'status')) throw new Error('status projection lost a task')
  if (!readTaskProjection(db, task.id, 'detail')) throw new Error('detail projection lost a task')
  readTasks++
}
const active = listActiveTasks()
if (active.length !== countActiveTasks()) throw new Error('active task list and count disagree')
oldestRunningTaskAgeSeconds()

const agents = listAgentState({ includeExpired: true })
for (const agent of agents) {
  if (!getAgentState(agent.agentId)) throw new Error('listed agent is not readable by id')
}
const events = listEvents({ limit: PROBE_EVENT_LIMIT })

const probe: StartProbe = {
  bootstrapMs,
  listedTasks: tasks.length,
  readTasks,
  activeTasks: active.length,
  agentRows: agents.length,
  agentStatuses: [...new Set(agents.map(agent => agent.status ?? null))].sort((a, b) => String(a).localeCompare(String(b))),
  eventRows: events.length,
}
// Close so the WAL is checkpointed before the parent snapshots the file.
db.close()
console.log(PROBE_MARKER + JSON.stringify(probe))
