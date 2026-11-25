import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentTask, RunRequest } from '@forge/shared'
import { config } from '../config.js'
import { execAsAgent, gitAsync, type RunOpts } from './git.js'
import { isPlainAbsolutePath, resolveAllowedRepo } from './repo-path.js'

// Per-task workspaces: one forge-owned bare mirror per repo (<root>/.mirrors/<repo>) and one git worktree per
// task (<root>/.tasks/<taskId>) on its own topic branch. Worktrees share the mirror's objects, so a task costs a
// checkout rather than a full clone, and two tasks on the same repo never share a working tree.
/** A per-task checkout: a repo name the runner knows (not a path) and the branch to start from. */
export interface WorkspaceRequest {
  repo: string
  base: string
}
/** A task that may run in its own worktree; repo is then that worktree's path and branch its topic. */
export type RunnerTask = AgentTask & { workspace?: WorkspaceRequest }
/** POST /tasks body: `repo` (an existing clone's path) or `workspace`; with workspace, `branch` names the topic. */
export type TaskRequest = Omit<RunRequest, 'repo'> & { repo?: string; workspace?: unknown }

export interface WorkspaceLayout {
  root: string
  allowedRoots: readonly string[]
  /** Explicitly allowed repo names and their remote URLs (WORKSPACE_REPOS="name=url,name=url"). */
  remotes: Readonly<Record<string, string>>
  /** Most worktrees that may exist under .tasks at once (running plus kept); new workspace tasks fail beyond it. */
  maxTasks: number
  /** A requested topic branch must start with one of these. */
  topicPrefixes: readonly string[]
}

export function workspaceLayoutFromEnv(allowedRoots: readonly string[], env = process.env): WorkspaceLayout {
  const remotes: Record<string, string> = {}
  for (const pair of (env.WORKSPACE_REPOS ?? '').split(',')) {
    const at = pair.indexOf('=')
    const name = pair.slice(0, at).trim()
    if (at > 0 && isRepoName(name)) remotes[name] = pair.slice(at + 1).trim()
  }
  const maxTasks = Number.parseInt(env.WORKSPACE_MAX_TASKS ?? '', 10)
  const prefixes = (env.WORKSPACE_TOPIC_PREFIXES ?? DEFAULT_TOPIC_PREFIXES.join(','))
    .split(',').map(p => p.trim()).filter(p => p.endsWith('/') && isRefName(`${p}x`))
  return {
    root: (env.WORKSPACE_ROOT ?? '/opt/repos').replace(/\/+$/, ''),
    allowedRoots,
    remotes,
    maxTasks: Number.isInteger(maxTasks) && maxTasks > 0 ? maxTasks : 30,
    topicPrefixes: prefixes.length ? prefixes : DEFAULT_TOPIC_PREFIXES,
  }
}

const DEFAULT_TOPIC_PREFIXES = ['forge/', 'feat/', 'fix/', 'chore/', 'docs/', 'refactor/', 'test/']

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
// A conservative subset of git's ref rules: no leading "-", no "..", "//", "@{", or trailing "/", "." or ".lock".
const REF_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*(?:\/|\.|\.lock)$)[A-Za-z0-9._/-]{1,200}$/

export function isRepoName(name: unknown): name is string {
  return typeof name === 'string' && REPO_NAME.test(name) && !name.endsWith('.lock')
}

export function isRefName(name: unknown): name is string {
  return typeof name === 'string' && REF_NAME.test(name) && !name.split('/').some(s => s.startsWith('.'))
}

export function workspaceTopic(taskId: string, requested?: string): string {
  return requested ?? `forge/task-${taskId.slice(0, 8)}`
}

/** A topic branch a caller may ask for: a valid name under one of the allowed prefixes (never main etc.). */
export function isAllowedTopic(name: unknown, layout: WorkspaceLayout): name is string {
  return isRefName(name) && layout.topicPrefixes.some(prefix => name.startsWith(prefix) && name.length > prefix.length)
}

/** Remote URLs must not carry credentials (the mirror's config is readable by agents); use a credential helper. */
export function hasUrlCredentials(url: string): boolean {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/@]*)@/i.exec(url)
  if (!m) return false
  // ssh://git@host is a user name, not a credential; anything else before @ is refused.
  return !/^ssh:/i.test(url) || m[1].includes(':')
}

/** Validates a POST /tasks `workspace`: a repo the runner may check out, and a base branch name. */
export function validateWorkspace(input: unknown, layout: WorkspaceLayout): { spec: WorkspaceRequest } | { error: string } {
  const w = input as Partial<WorkspaceRequest> | null
  if (!w || typeof w !== 'object') return { error: 'workspace must be an object with repo and base' }
  if (!isRepoName(w.repo)) return { error: 'workspace.repo must be a plain repository name' }
  if (!isRefName(w.base)) return { error: 'workspace.base must be a branch name' }
  if (!layout.remotes[w.repo] && !resolveAllowedRepo(join(layout.root, w.repo), layout.allowedRoots)) {
    return { error: 'workspace.repo is not an allowed repository' }
  }
  return { spec: { repo: w.repo, base: w.base } }
}

export function taskWorkspacePath(layout: WorkspaceLayout, taskId: string): string {
  return join(layout.root, '.tasks', taskId)
}

// One lock per repo: mirror creation, fetch, worktree add and remove all write the mirror's refs and
// worktree list. The runner is a single process, so an in-process promise chain is enough.
const locks = new Map<string, Promise<unknown>>()
function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(repo) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(fn)
  const tail = next.catch(() => undefined)
  locks.set(repo, tail)
  void tail.then(() => { if (locks.get(repo) === tail) locks.delete(repo) })
  return next
}

// The runner is root, and the workspace root is agent-writable: root never creates, chowns or follows anything
// there. The agent account creates these directories itself; anything that is not a real directory owned by it
// (a symlink, a file, a root-owned leftover) is refused.
async function ensureAgentDir(path: string, opts: RunOpts): Promise<void> {
  if (!isPlainAbsolutePath(path)) throw new Error('workspace directory is not a plain absolute path')
  await execAsAgent('mkdir', ['-p', '--', path], '/', opts)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${path} is not a directory`)
  if (stat.uid !== opts.uid) throw new Error(`${path} is not owned by the agent account`)
}

function exists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

async function remoteUrl(layout: WorkspaceLayout, repo: string, opts: RunOpts): Promise<string> {
  if (layout.remotes[repo]) return layout.remotes[repo]
  const clone = resolveAllowedRepo(join(layout.root, repo), layout.allowedRoots)
  if (!clone) throw new Error('workspace.repo is not an allowed repository')
  const url = await gitAsync(['remote', 'get-url', 'origin'], clone, opts)
  if (!url) throw new Error(`${clone} has no origin remote`)
  return url
}

async function ensureMirror(layout: WorkspaceLayout, repo: string, opts: RunOpts): Promise<string> {
  const mirrors = join(layout.root, '.mirrors')
  await ensureAgentDir(mirrors, opts)
  const mirror = join(mirrors, repo)
  if (!resolveAllowedRepo(mirror, [mirrors])) {
    if (exists(mirror)) throw new Error(`${mirror} exists but is not a plain directory`)
    // A bare repo with only remote-tracking refs, so a topic branch can never collide with a copied head.
    const url = await remoteUrl(layout, repo, opts)
    if (hasUrlCredentials(url)) throw new Error('the remote URL carries credentials; use the agent account\'s credential helper')
    await gitAsync(['init', '--quiet', '--bare', '--', mirror], mirrors, opts)
    await gitAsync(['remote', 'add', '--', 'origin', url], mirror, opts)
  }
  await gitAsync(['fetch', '--quiet', '--prune', 'origin'], mirror, opts)
  return mirror
}

/** Fetches the repo's mirror and adds a worktree for the task on a new topic branch off origin/<base>. */
export function createWorkspace(layout: WorkspaceLayout, taskId: string, spec: WorkspaceRequest, topic: string,
  opts: RunOpts): Promise<string> {
  if (!isRefName(topic)) return Promise.reject(new Error('invalid topic branch name'))
  return withRepoLock(spec.repo, async () => {
    const tasks = join(layout.root, '.tasks')
    await ensureAgentDir(tasks, opts)
    // Kept worktrees (uncommitted or unpushed work) stay until reviewed or pruned; never let them fill the disk.
    const existing = readdirSync(tasks).length
    if (existing >= layout.maxTasks) {
      throw new Error(`${existing} task worktrees exist under ${tasks} (limit ${layout.maxTasks}); review or prune kept ones first`)
    }
    const mirror = await ensureMirror(layout, spec.repo, opts)
    const path = taskWorkspacePath(layout, taskId)
    await gitAsync(['worktree', 'add', '--quiet', '--no-track', '-b', topic, path, `refs/remotes/origin/${spec.base}`], mirror, opts)
    return path
  })
}

export interface WorkspaceOutcome { removed: boolean; reason: string }

/**
 * Removes the task's worktree (and its local branch) only when nothing would be lost: no uncommitted or untracked
 * files, and every commit on the branch is already on the remote (pushed, or the branch has no commits of its
 * own). Anything else is kept for a person to look at; a pruner removes clean worktrees after they sit idle.
 */
export function finishWorkspace(layout: WorkspaceLayout, taskId: string, spec: WorkspaceRequest, opts: RunOpts)
  : Promise<WorkspaceOutcome> {
  return withRepoLock(spec.repo, async () => {
    const path = taskWorkspacePath(layout, taskId)
    if (!resolveAllowedRepo(path, [join(layout.root, '.tasks')])) return { removed: false, reason: 'no workspace' }
    if (await gitAsync(['status', '--porcelain'], path, opts)) return { removed: false, reason: 'uncommitted changes' }
    if (await gitAsync(['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes=origin'], path, opts)) {
      return { removed: false, reason: 'commits not pushed' }
    }
    const branch = await gitAsync(['symbolic-ref', '--quiet', '--short', 'HEAD'], path, opts).catch(() => '')
    const mirror = join(layout.root, '.mirrors', spec.repo)
    await gitAsync(['worktree', 'remove', path], mirror, opts)
    if (branch) await gitAsync(['branch', '-D', '--', branch], mirror, opts).catch(() => '')
    return { removed: true, reason: 'clean and pushed' }
  })
}

export const workspaceLayout = workspaceLayoutFromEnv(config.allowedRepoPaths)
