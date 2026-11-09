import { dirname } from 'node:path'
import { realpathSync } from 'node:fs'
import { Router } from 'express'
import { countActiveProcs } from '../agent/runner.js'
import { countActiveTasks, oldestRunningTaskAgeSeconds } from '../db/queries.js'
import { freeDiskBytes } from '../agent/disk.js'
import { config } from '../config.js'
import { db } from '../db/schema.js'
import { version } from '../version.js'

function freeDiskMbOf(path: string): number | null {
  try {
    return Math.floor(freeDiskBytes(path) / 1048576)
  } catch {
    return null
  }
}

export const healthRouter = Router()

healthRouter.get('/health', (_req, res) => {
  const freeDiskMb = freeDiskMbOf(config.allowedRepoPaths[0])
  const diskOk = freeDiskMb === null ? null : freeDiskMb >= config.minFreeDiskMb

  // Admission (tasks.ts) refuses new work when EITHER the repo volume or the
  // data volume is below MIN_FREE_DISK_MB, where the data volume is the
  // filesystem backing forge.db and its WAL. Report that volume too so /health
  // cannot look healthy while every new task is rejected for low data-volume
  // space. realpathSync resolves a symlinked db to its real filesystem; a stat
  // failure yields null rather than throwing.
  let dataFreeDiskMb: number | null = null
  try {
    dataFreeDiskMb = freeDiskMbOf(dirname(realpathSync(db.name)))
  } catch {
    dataFreeDiskMb = null
  }
  const dataDiskOk = dataFreeDiskMb === null ? null : dataFreeDiskMb >= config.minFreeDiskMb

  // One go/no-go that mirrors admitCheckout (tasks.ts): a new task is refused
  // when EITHER disk volume is below MIN_FREE_DISK_MB or concurrency is full.
  // Expose the same combined verdict so dispatchers stop re-deriving it from the
  // raw fields and drifting from the real admission rule. An unknown (null) disk
  // reading is treated as not-accepting: fail-safe rather than claim capacity we
  // cannot verify. This is a readiness hint only — status stays 'ok' (liveness).
  const queuedOrRunning = countActiveTasks()
  const acceptingTasks =
    diskOk === true && dataDiskOk === true && queuedOrRunning < config.maxConcurrentTasks

  // When acceptingTasks is false, say WHY in a single machine-readable code so a
  // dispatcher does not have to re-derive the rule from the raw fields (the exact
  // drift acceptingTasks was added to prevent). Precedence mirrors the fail-safe
  // bias of acceptingTasks: a null/unverifiable disk reading reports 'unknown'
  // FIRST — it is never silently masked by concurrency, so the field cannot read
  // healthy over an unmeasured volume. Then the concrete low-disk reasons ('disk'
  // = repo volume, 'dataDisk' = sqlite volume) ahead of 'concurrency', matching
  // admitCheckout's disk-before-slots order. null when accepting.
  const notAcceptingReason: 'concurrency' | 'disk' | 'dataDisk' | 'unknown' | null =
    acceptingTasks
      ? null
      : diskOk === null || dataDiskOk === null
        ? 'unknown'
        : diskOk === false
          ? 'disk'
          : dataDiskOk === false
            ? 'dataDisk'
            : queuedOrRunning >= config.maxConcurrentTasks
              ? 'concurrency'
              : 'unknown'

  res.json({
    status: 'ok',
    version,
    activeTasks: countActiveProcs(),
    queuedOrRunning,
    maxConcurrentTasks: config.maxConcurrentTasks,
    // The thresholds the measured fields are judged against, so a monitor can
    // compute headroom ('how close is oldestRunningTaskAgeSeconds to the
    // SIGTERM deadline', 'how much disk is left above the admission floor')
    // from this one poll instead of a second /capabilities call.
    taskTimeoutMs: config.taskTimeoutMs,
    minFreeDiskMb: config.minFreeDiskMb,
    freeDiskMb,
    diskOk,
    dataFreeDiskMb,
    dataDiskOk,
    acceptingTasks,
    notAcceptingReason,
    uptimeSeconds: Math.floor(process.uptime()),
    oldestRunningTaskAgeSeconds: oldestRunningTaskAgeSeconds(),
  })
})
