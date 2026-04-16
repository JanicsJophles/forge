import { Router } from 'express'
import { countActiveProcs } from '../agent/runner.js'

export const healthRouter = Router()

healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', activeTasks: countActiveProcs() })
})
