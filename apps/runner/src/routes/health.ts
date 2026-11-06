import { Router } from 'express'
import { countActiveProcs } from '../agent/runner.js'
import { countActiveTasks } from '../db/queries.js'
import { freeDiskBytes } from '../agent/disk.js'
import { config } from '../config.js'

export const healthRouter = Router()

healthRouter.get('/health', (_req, res) => {
  let freeDiskMb: number | null = null
  try {
    freeDiskMb = Math.floor(freeDiskBytes(config.allowedRepoPaths[0]) / 1048576)
  } catch {
    freeDiskMb = null
  }
  const diskOk = freeDiskMb === null ? null : freeDiskMb >= config.minFreeDiskMb

  res.json({
    status: 'ok',
    activeTasks: countActiveProcs(),
    queuedOrRunning: countActiveTasks(),
    maxConcurrentTasks: config.maxConcurrentTasks,
    freeDiskMb,
    diskOk,
    uptimeSeconds: Math.floor(process.uptime()),
  })
})
