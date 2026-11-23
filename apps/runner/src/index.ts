import { mkdirSync, chmodSync } from 'node:fs'
import express from 'express'
import { config } from './config.js'
import './db/schema.js'  // runs CREATE TABLE on import
import { healthRouter } from './routes/health.js'
import { tasksRouter } from './routes/tasks.js'
import { reposRouter } from './routes/repos.js'
import { agentStateRouter } from './routes/agent-state.js'
import { dashboardRouter } from './routes/dashboard.js'
import { sweepStaleReadOnlyDirs } from './agent/readonly.js'
import { sweepStaleTaskCgroups } from './agent/cgroup.js'
import { readOnlyIdentityFor } from './capabilities.js'

// The disposable read-only copies live under a root-owned, mode-0711 base dir (never
// /tmp — finding D). Create it up front so a task never has to; 0711 lets the read-only
// account traverse into its own mkdtemp subdir but not enumerate siblings. Best-effort:
// when the runner is not root (CI / dev) read-only is unsupported anyway, so a failure
// here is not fatal.
try {
  mkdirSync(config.readonlyBaseDir, { recursive: true })
  chmodSync(config.readonlyBaseDir, 0o711)
} catch (err) {
  console.warn(`[forge] could not prepare read-only base dir ${config.readonlyBaseDir}: ${err instanceof Error ? err.message : 'unknown error'}`)
}

// Remove read-only copy temp dirs orphaned by a previous process (crash / pm2
// restart / OOM kill). Safe to run here: schema.ts has just failed every in-flight
// task, so nothing is using one of these dirs. Only touch dirs owned by root or the
// configured read-only account (finding D) — never one some other local user planted.
const roIdentity = readOnlyIdentityFor(config.readonlyRunUser)
const roUid = roIdentity?.uid
const allowedUids = roUid !== undefined ? [0, roUid] : [0]
const swept = await sweepStaleReadOnlyDirs(config.readonlyBaseDir, allowedUids, roIdentity ?? {})
if (swept > 0) console.log(`[forge] swept ${swept} stale read-only temp dir(s)`)

// Reap any task cgroups the previous process left behind (finding A): kill survivors,
// remove the empty nodes. No-op when the runner cannot manage cgroups (non-root / CI).
const sweptCgroups = sweepStaleTaskCgroups()
if (sweptCgroups > 0) console.log(`[forge] swept ${sweptCgroups} stale read-only cgroup(s)`)

const app = express()

app.use(express.json())

// Process-level safety nets
process.on('unhandledRejection', (reason) => {
  console.error('[forge] unhandledRejection — exiting', reason)
  process.exit(1)
})
process.on('uncaughtException', (err) => {
  console.error('[forge] uncaughtException — exiting', err)
  process.exit(1)
})

// Routes
app.use(healthRouter)
app.use('/tasks', tasksRouter)
app.use('/repos', reposRouter)
app.use(agentStateRouter)
app.use(dashboardRouter)

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ error: 'not found' })
})

app.listen(config.port, config.host, () => {
  console.log(`[forge] runner listening on ${config.host}:${config.port}`)
  console.log(`[forge] allowed repo paths: ${config.allowedRepoPaths.join(', ')}`)
})
