import { Router } from 'express'
import { config } from '../config.js'
import { version } from '../version.js'

export const capabilitiesRouter = Router()

// Versioned contract, not a claim that either CLI is authenticated.
// Static discovery must never probe login state or start runner operations.
capabilitiesRouter.get('/capabilities', (_req, res) => {
  res.json({
    providerSelectionVersion: 1,
    providers: ['claude', 'codex'],
    version,
    // Whether a bearer token guards state-changing routes. Lets dispatchers
    // decide up front whether they must send an Authorization header.
    authRequired: config.authToken !== undefined,
    limits: {
      maxConcurrentTasks: config.maxConcurrentTasks,
      taskTimeoutMs: config.taskTimeoutMs,
      minFreeDiskMb: config.minFreeDiskMb,
      autoCommit: config.autoCommit,
    },
  })
})
