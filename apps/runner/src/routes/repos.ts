import { Router, Response } from 'express'
import { readdirSync, existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { config } from '../config.js'
import { getCurrentBranch, hasUncommittedChanges } from '../agent/git.js'

export const reposRouter = Router()

interface RepoSummary {
  name: string
  path: string
  currentBranch: string
  dirty: boolean
  statusError?: 'unavailable'
}

// Accept git readers separately so discovery can be tested without a live runner.
export function discoverRepos(
  allowedPaths: string[],
  git = { getCurrentBranch, hasUncommittedChanges },
): RepoSummary[] {
  const paths = new Set<string>()
  for (const allowedPath of allowedPaths) {
    const basePath = resolve(allowedPath)
    if (existsSync(join(basePath, '.git'))) paths.add(basePath)
    try {
      for (const entry of readdirSync(basePath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const fullPath = join(basePath, entry.name)
        // .git may be a directory or a worktree's pointer file.
        if (existsSync(join(fullPath, '.git'))) paths.add(fullPath)
      }
    } catch {
      // A missing or unreadable container must not hide other allowed roots.
    }
  }

  const repos: RepoSummary[] = []
  for (const path of paths) {
    let currentBranch = 'unknown'
    try { currentBranch = git.getCurrentBranch(path) } catch { /* empty */ }

    // Dispatchers must never interpret an unavailable status as safe to use.
    let dirty = true
    let statusError: RepoSummary['statusError']
    try { dirty = git.hasUncommittedChanges(path) } catch { statusError = 'unavailable' }
    repos.push({ name: basename(path), path, currentBranch, dirty,
      ...(statusError ? { statusError } : {}) })
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}

// GET /repos — list allowed git checkout roots and their immediate children.
reposRouter.get('/', (_req, res: Response) => {
  res.json(discoverRepos(config.allowedRepoPaths))
})
