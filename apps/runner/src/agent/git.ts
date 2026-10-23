import { execFileSync } from "node:child_process"

interface RunOpts {
  uid?: number
  gid?: number
}

// Every call passes argv straight to git, never through a shell: commit messages
// carry task prompts, so `$(...)` or backticks in one must stay plain text.
function git(args: string[], cwd: string, opts: RunOpts = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
    ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
  }).trim()
}

export function getCurrentBranch(repoPath: string): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath)
}

/**
 * Best-effort: make sure the .git/ subtree is owned by the user that will
 * subsequently run as. The runner historically spawned `git pull` as root,
 * which created root-owned objects under .git/objects/; once we drop privs
 * to the forge user for subsequent git ops, those root-owned files break
 * `git add` / `git commit`. Walking the tree on every run is cheap enough
 * to do unconditionally rather than detect the problem after it manifests.
 *
 * Silently swallows errors — chown is not allowed across mount boundaries
 * or for non-root, and that's fine.
 */
function ensureRepoOwnership(repoPath: string, opts: RunOpts): void {
  if (opts.uid === undefined || opts.gid === undefined) return
  // Chown the ENTIRE repo, not just .git/. Working-tree files get
  // root-owned too if a prior agent ran with elevated privs and wrote
  // files (e.g. a refactor that touched src/ from root). Without this,
  // the next agent (running as forge) hits ENOENT-equivalent failures
  // editing src/. Mass-chown is cheap on these repos (< 1s).
  try {
    execFileSync("chown", ["-R", `${opts.uid}:${opts.gid}`, "--", repoPath], {
      stdio: "ignore",
    })
  } catch {
    // not running as root, or .git doesn't exist yet — neither case is a real error
  }
}

export function gitPull(repoPath: string, opts: RunOpts = {}): void {
  ensureRepoOwnership(repoPath, opts)
  // If there is no upstream configured (e.g. fresh local repo), pulling
  // is a no-op rather than a hard failure. We detect this by checking
  // whether there is a remote tracking branch before attempting.
  try {
    const upstream = execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
      ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
    }).trim()
    if (upstream) {
      git(["pull", "--ff-only"], repoPath, opts)
    }
  } catch {
    // No upstream configured — skip pull silently
  }
}

export function gitCommit(repoPath: string, message: string, opts: RunOpts = {}): string {
  // Stage all tracked modifications (but not untracked files — let the
  // agent's own git add handle staging if it chose to add new files)
  try {
    git(["add", "-u"], repoPath, opts)
  } catch {
    // Nothing tracked was modified — that's fine
  }

  try {
    git(["commit", "-m", message], repoPath, opts)
  } catch (err: any) {
    // "nothing to commit" is not a real error
    if (err.stdout?.includes("nothing to commit") || err.stderr?.includes("nothing to commit")) {
      return ""
    }
    throw err
  }

  return git(["rev-parse", "HEAD"], repoPath, opts)
}

export function hasUncommittedChanges(repoPath: string, opts: RunOpts = {}): boolean {
  const output = git(["status", "--porcelain"], repoPath, opts)
  return output.length > 0
}
