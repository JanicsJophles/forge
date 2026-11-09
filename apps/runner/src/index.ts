import express, { ErrorRequestHandler } from 'express'
import { config } from './config.js'
import './db/schema.js'  // runs CREATE TABLE on import
import { capabilitiesRouter } from './routes/capabilities.js'
import { healthRouter } from './routes/health.js'
import { taskLogRouter } from './routes/task-log.js'
import { taskLogViewRouter } from './routes/task-log-view.js'
import { taskChangesViewRouter } from './routes/task-changes-view.js'
import { taskHistoryViewRouter } from './routes/task-history-view.js'
import { tasksRouter } from './routes/tasks.js'
import { reposRouter } from './routes/repos.js'
import { agentStateRouter } from './routes/agent-state.js'
import { dashboardRouter } from './routes/dashboard.js'
import { rootRouter } from './routes/root.js'
import { requireBearerAuth } from './routes/auth.js'

const app = express()

// Optional bearer-token gate on state-changing routes. Runs before the body
// parser so an unauthenticated request body is never parsed. A pass-through when
// no token is configured (auth off).
if (config.authToken) {
  console.log('[forge] bearer-token auth enabled on state-changing routes')
} else {
  console.warn('[forge] FORGE_AUTH_TOKEN not set — state-changing routes accept unauthenticated requests')
}
app.use(requireBearerAuth(config.authToken))

// Explicit limit sized for large prompts (default is 100kb).
app.use(express.json({ limit: '2mb' }))

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
app.use(rootRouter)
app.use(healthRouter)
app.use(capabilitiesRouter)
app.use('/tasks', taskLogRouter)
// Distinct /:id/log/view segment — mounted after the byte-slice log router so
// the exact /:id/log route always wins its match; neither shadows the other.
app.use('/tasks', taskLogViewRouter)
// Exact /:id/changes/view path, alongside the log viewer, before task routes.
app.use('/tasks', taskChangesViewRouter)
app.use('/tasks', tasksRouter)
app.use('/repos', reposRouter)
app.use(agentStateRouter)
app.use(dashboardRouter)
app.use(taskHistoryViewRouter)

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ error: 'not found' })
})

// Terminal error handler — keeps every response as {error} JSON instead of
// falling through to Express's default HTML stack-trace page.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) return

  const type = (err as { type?: string }).type
  if (err instanceof SyntaxError && type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid JSON body' })
    return
  }
  if (type === 'entity.too.large') {
    res.status(413).json({ error: 'request body too large' })
    return
  }

  console.error('[forge] unhandled request error', err)
  res.status(500).json({ error: 'internal error' })
}
app.use(errorHandler)

app.listen(config.port, config.host, () => {
  console.log(`[forge] runner listening on ${config.host}:${config.port}`)
  console.log(`[forge] allowed repo paths: ${config.allowedRepoPaths.join(', ')}`)
})
