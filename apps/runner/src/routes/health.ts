import { Router } from 'express'
import { countActiveProcs } from '../agent/runner.js'
import { countActiveTasks } from '../db/queries.js'
import { config } from '../config.js'

export const healthRouter = Router()

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    activeTasks: countActiveProcs(),
    queuedOrRunning: countActiveTasks(),
    maxConcurrentTasks: config.maxConcurrentTasks,
  })
})
