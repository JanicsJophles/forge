import { Router, Response } from 'express'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.js'
import { getCurrentBranch } from '../agent/git.js'

export const reposRouter = Router()

// GET /repos — list all git repos inside ALLOWED_REPO_PATHS
reposRouter.get('/', (_req, res: Response) => {
  const repos: { name: string; path: string; currentBranch: string }[] = []

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
      try { currentBranch = getCurrentBranch(fullPath) } catch { /* empty */ }

      repos.push({ name: entry.name, path: fullPath, currentBranch })
    }
  }

  repos.sort((a, b) => a.name.localeCompare(b.name))
  res.json(repos)
})
