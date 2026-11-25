import { Router, Response } from 'express'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.js'
import { getCurrentBranch } from '../agent/git.js'
import { executionIdentity } from '../agent/provider.js'

export const reposRouter = Router()

// GET /repos — list all git repos inside ALLOWED_REPO_PATHS
reposRouter.get('/', (_req, res: Response) => {
  const repos: { name: string; path: string; currentBranch: string }[] = []
  // Each clone's .git/config is agent-writable, so git runs as the agent account (never root) for the listing.
  let identity: ReturnType<typeof executionIdentity> | null = null
  try { identity = executionIdentity(config.claudeRunUser) } catch { /* listed with branch 'unknown' */ }

  for (const basePath of config.allowedRepoPaths) {
    let entries
    try {
      entries = readdirSync(basePath, { withFileTypes: true })
    } catch {
      continue  // basePath doesn't exist — skip silently
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const fullPath = join(basePath, entry.name)
      if (!existsSync(join(fullPath, '.git'))) continue

      let currentBranch = 'unknown'
      if (identity) try { currentBranch = getCurrentBranch(fullPath, identity) } catch { /* empty */ }

      repos.push({ name: entry.name, path: fullPath, currentBranch })
    }
  }

  repos.sort((a, b) => a.name.localeCompare(b.name))
  res.json(repos)
})
