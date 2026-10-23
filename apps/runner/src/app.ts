import express, { type Express } from 'express'
import { config } from './config.js'
import './db/schema.js'  // runs CREATE TABLE on import
import { runnerAuth, type RunnerAuthOptions } from './routes/auth.js'
import { healthRouter } from './routes/health.js'
import { tasksRouter } from './routes/tasks.js'
import { reposRouter } from './routes/repos.js'
import { agentStateRouter } from './routes/agent-state.js'
import { dashboardRouter } from './routes/dashboard.js'

export function createApp(auth: RunnerAuthOptions = { token: config.runnerToken }): Express {
  const app = express()

  // Before the body parser, so an unauthenticated write is refused unread.
  app.use(runnerAuth(auth))
  app.use(express.json())

  app.use(healthRouter)
  app.use('/tasks', tasksRouter)
  app.use('/repos', reposRouter)
  app.use(agentStateRouter)
  app.use(dashboardRouter)

  // 404 catch-all
  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' })
  })

  return app
}
