import { Router } from 'express'
import { countActiveProcs } from '../agent/runner.js'
import { countActiveTasks, oldestRunningTaskAgeSeconds } from '../db/queries.js'
import { freeDiskBytes } from '../agent/disk.js'
import { config } from '../config.js'

export const metricsRouter = Router()

// Prometheus text exposition format version. Scrapers key off this content-type.
const CONTENT_TYPE = 'text/plain; version=0.0.4'

// Emit one gauge metric (HELP + TYPE + value). Null values are skipped by the
// caller, so a metric whose underlying read failed is simply absent rather than
// reported as 0 — which Prometheus treats as a real, misleading reading.
function gauge(name: string, help: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`
}

// Read free disk without ever throwing: a stat failure must still let the other
// metrics through. Returns null on error so the gauge is omitted.
function readFreeDiskMb(): number | null {
  try {
    return Math.floor(freeDiskBytes(config.allowedRepoPaths[0]) / 1048576)
  } catch {
    return null
  }
}

// Scrapeable runner stats in Prometheus exposition format. Read-only GET, so the
// bearer-auth gate (which only challenges state-changing methods) leaves it open
// for Prometheus to scrape without a credential.
metricsRouter.get('/metrics', (_req, res) => {
  const freeDiskMb = readFreeDiskMb()
  const oldestRunningAge = oldestRunningTaskAgeSeconds()

  let body = ''
  body += gauge('forge_active_tasks', 'Number of active claude/codex child processes.', countActiveProcs())
  body += gauge(
    'forge_queued_or_running',
    'Number of tasks currently queued or running.',
    countActiveTasks()
  )
  body += gauge(
    'forge_max_concurrent_tasks',
    'Configured maximum number of concurrent tasks.',
    config.maxConcurrentTasks
  )
  if (freeDiskMb !== null) {
    body += gauge(
      'forge_free_disk_mb',
      'Free disk space in megabytes on the allowed repo volume.',
      freeDiskMb
    )
  }
  body += gauge('forge_uptime_seconds', 'Runner process uptime in seconds.', Math.floor(process.uptime()))
  if (oldestRunningAge !== null) {
    body += gauge(
      'forge_oldest_running_task_age_seconds',
      'Age in seconds of the oldest currently running task.',
      oldestRunningAge
    )
  }

  res.type(CONTENT_TYPE).send(body)
})
