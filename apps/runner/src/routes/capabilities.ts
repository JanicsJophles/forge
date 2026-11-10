import { Router } from 'express'
import { config } from '../config.js'
import { version } from '../version.js'
import { MAX_LOG_SLICE_BYTES } from '../db/task-log.js'
import { LOG_TAIL_BYTES } from '../db/task-projection.js'
import { RETENTION_INTERVAL_MS } from '../db/retention.js'

// config evaluates retentionDaysFromEnv once at module load, shared with startup.
const retentionDays = config.retentionDays

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
    // Build identity a dispatcher/bridge needs to correlate runner builds with
    // the commits it auto-tags. gitShaPinned is a boolean, never the raw SHA, so
    // the deployed commit stays an implementation detail; commitMessagePrefix is
    // already public (it appears verbatim on every [forge] auto-commit).
    build: {
      version,
      gitShaPinned: config.gitSha !== undefined,
      commitMessagePrefix: config.commitMessagePrefix,
    },
    // Pruning frees reusable SQLite pages; it does not promise file shrinkage.
    retention: {
      enabled: retentionDays > 0,
      days: retentionDays,
      intervalSeconds: RETENTION_INTERVAL_MS / 1000,
    },
    limits: {
      maxConcurrentTasks: config.maxConcurrentTasks,
      taskTimeoutMs: config.taskTimeoutMs,
      minFreeDiskMb: config.minFreeDiskMb,
      autoCommit: config.autoCommit,
    },
    // Real byte bounds a log-pagination client must respect. Sourced from the
    // same constants the log routes enforce, so external pagers never drift.
    logging: {
      maxSliceBytes: MAX_LOG_SLICE_BYTES,
      detailTailBytes: LOG_TAIL_BYTES,
    },
  })
})
