import express from 'express'
import { config } from './config.js'
import './db/schema.js'  // runs CREATE TABLE on import
import { healthRouter } from './routes/health.js'
import { tasksRouter } from './routes/tasks.js'
import { reposRouter } from './routes/repos.js'
import { agentStateRouter } from './routes/agent-state.js'
import { dashboardRouter } from './routes/dashboard.js'

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
