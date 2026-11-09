import { readFileSync } from 'node:fs'
import { config } from './config.js'

// Resolve the build version from the package manifest once at load. A briefly
// unreadable or malformed package.json must never take a route down: fall back
// to '0.0.0' so callers still answer 200.
function readPackageVersion(): string {
  try {
    const manifestUrl = new URL('../package.json', import.meta.url)
    const parsed = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const packageVersion = readPackageVersion()

// Append the deployed git SHA (semver build metadata) when operators set it, so
// dispatchers can tell which exact build is live.
export const version = config.gitSha ? `${packageVersion}+${config.gitSha}` : packageVersion
