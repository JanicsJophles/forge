import { readFileSync } from 'node:fs'
import { Router } from 'express'
import { config } from '../config.js'

export const capabilitiesRouter = Router()

// Resolve the build version from the package manifest once at load. A briefly
// unreadable or malformed package.json must never take the route down: fall
// back to '0.0.0' so /capabilities still answers 200.
function readPackageVersion(): string {
  try {
    const manifestUrl = new URL('../../package.json', import.meta.url)
    const parsed = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const packageVersion = readPackageVersion()
// Append the deployed git SHA (semver build metadata) when operators set it, so
// dispatchers can tell which exact build is live.
const version = config.gitSha ? `${packageVersion}+${config.gitSha}` : packageVersion

// Versioned contract, not a claim that either CLI is authenticated.
// Static discovery must never probe login state or start runner operations.
capabilitiesRouter.get('/capabilities', (_req, res) => {
  res.json({
    providerSelectionVersion: 1,
    providers: ['claude', 'codex'],
    version,
    limits: {
      maxConcurrentTasks: config.maxConcurrentTasks,
      taskTimeoutMs: config.taskTimeoutMs,
      minFreeDiskMb: config.minFreeDiskMb,
      autoCommit: config.autoCommit,
    },
  })
})
