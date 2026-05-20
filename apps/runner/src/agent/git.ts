import { execSync } from "node:child_process"

interface RunOpts {
  uid?: number
  gid?: number
}

function exec(cmd: string, cwd: string, opts: RunOpts = {}): string {
  return execSync(cmd, {
    cwd,
    encoding: "utf8",
    ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
    ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
  }).trim()
}

export function getCurrentBranch(repoPath: string): string {
  return exec("git rev-parse --abbrev-ref HEAD", repoPath)
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
    execSync(`chown -R ${opts.uid}:${opts.gid} ${JSON.stringify(repoPath)}`, {
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
    const upstream = execSync("git rev-parse --abbrev-ref --symbolic-full-name @{u}", {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
      ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
    }).trim()
    if (upstream) {
      exec("git pull --ff-only", repoPath, opts)
    }
  } catch {
    // No upstream configured — skip pull silently
  }
}

export function gitCommit(repoPath: string, message: string, opts: RunOpts = {}): string {
  // Stage all tracked modifications (but not untracked files — let the
  // agent's own git add handle staging if it chose to add new files)
  try {
    exec("git add -u", repoPath, opts)
  } catch {
    // Nothing tracked was modified — that's fine
  }

  try {
    exec(`git commit -m ${JSON.stringify(message)}`, repoPath, opts)
  } catch (err: any) {
    // "nothing to commit" is not a real error
    if (err.stdout?.includes("nothing to commit") || err.stderr?.includes("nothing to commit")) {
      return ""
    }
    throw err
  }

  return exec("git rev-parse HEAD", repoPath, opts)
}

export function hasUncommittedChanges(repoPath: string, opts: RunOpts = {}): boolean {
  const output = exec("git status --porcelain", repoPath, opts)
  return output.length > 0
}
