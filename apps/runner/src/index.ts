import express, { ErrorRequestHandler } from 'express'
import { config } from './config.js'
import './db/schema.js'  // runs CREATE TABLE on import
import { healthRouter } from './routes/health.js'
import { tasksRouter } from './routes/tasks.js'
import { reposRouter } from './routes/repos.js'
import { agentStateRouter } from './routes/agent-state.js'
import { dashboardRouter } from './routes/dashboard.js'

const app = express()

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
app.use(healthRouter)
app.use('/tasks', tasksRouter)
app.use('/repos', reposRouter)
app.use(agentStateRouter)
app.use(dashboardRouter)

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
