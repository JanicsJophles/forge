import { Router, Response } from 'express'
import { readdirSync, existsSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { config } from '../config.js'
import { getCurrentBranch, getHeadCommit, hasUncommittedChanges, HeadCommit } from '../agent/git.js'

export const reposRouter = Router()

interface RepoSummary {
  name: string
  path: string
  currentBranch: string
  dirty: boolean
  branchError?: 'unavailable'
  head: HeadCommit | null
  statusError?: 'unavailable'
}

// Accept git readers separately so discovery can be tested without a live runner.
export function discoverRepos(
  allowedPaths: string[],
  git = { getCurrentBranch, getHeadCommit, hasUncommittedChanges },
): RepoSummary[] {
  const paths = new Set<string>()
  const addCheckout = (candidate: string) => {
    try {
      const path = realpathSync(candidate)
      // .git may be a directory or a worktree's pointer file.
      if (existsSync(join(path, '.git'))) paths.add(path)
    } catch {
      // A broken or disappearing alias must not hide other checkouts.
    }
  }
  for (const allowedPath of allowedPaths) {
    try {
      const basePath = realpathSync(allowedPath)
      addCheckout(basePath)
      for (const entry of readdirSync(basePath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const fullPath = join(basePath, entry.name)
        addCheckout(fullPath)
      }
    } catch {
      // A missing or unreadable container must not hide other allowed roots.
    }
  }

  const repos: RepoSummary[] = []
  for (const path of paths) {
    let currentBranch = 'unknown'
    let branchError: RepoSummary['branchError']
    try { currentBranch = git.getCurrentBranch(path) } catch { branchError = 'unavailable' }

    // Dispatchers must never interpret an unavailable status as safe to use.
    let dirty = true
    let statusError: RepoSummary['statusError']
    try { dirty = git.hasUncommittedChanges(path) } catch { statusError = 'unavailable' }

    // A failed head probe (e.g. an empty repo with no commits) yields null and
    // must not hide other repos or crash the request.
    let head: HeadCommit | null = null
    try { head = git.getHeadCommit(path) } catch { /* no resolvable HEAD */ }

    repos.push({ name: basename(path), path, currentBranch, dirty, head,
      ...(branchError ? { branchError } : {}),
      ...(statusError ? { statusError } : {}) })
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}

// GET /repos — list allowed git checkout roots and their immediate children.
reposRouter.get('/', (_req, res: Response) => {
  res.json(discoverRepos(config.allowedRepoPaths))
})
