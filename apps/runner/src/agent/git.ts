import { execFileSync, execSync } from "node:child_process"

interface RunOpts {
  uid?: number
  gid?: number
}

// Bind every Git subprocess to its supplied cwd, even when the runner was
// launched from a Git hook or another checkout. Never alter the parent env.
function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES",
  ]) delete env[key]
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" }
}

function exec(cmd: string, cwd: string, opts: RunOpts = {}): string {
  return execSync(cmd, {
    cwd,
    env: gitEnvironment(),
    encoding: "utf8",
    ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
    ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
  }).trim()
}

// Read probes run on the request thread: cap each at two seconds so a stuck
// Git process (including a filesystem monitor hook) cannot block it indefinitely.
const GIT_READ_TIMEOUT_MS = 2_000

function readGit(args: string[], repoPath: string, operation: string, opts: RunOpts = {}): string {
  try {
    return execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_READ_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: gitEnvironment(),
      ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
      ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
    }).trim()
  } catch {
    // Never attach the original error: callers may persist or return this message,
    // and child-process errors can contain stderr, paths, URLs, and credentials.
    throw new Error(`Git ${operation} unavailable; read probe failed or exceeded 2000ms`)
  }
}

export function getCurrentBranch(repoPath: string): string {
  return readGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath, "branch")
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

export function gitPull(repoPath: string, opts: RunOpts = {}, timeoutMs = 30_000): void {
  ensureRepoOwnership(repoPath, opts)
  // Do not expose Git's stderr (remote URLs can contain credentials) or attach
  // its original error as a cause: runTask persists this error's message.
  function git(args: string[], operation: string, allowMissing = false): string {
    try {
      return execFileSync("git", args, {
        cwd: repoPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        env: gitEnvironment(),
        ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
        ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
      }).trim()
    } catch (error) {
      const failure = error as { status?: number; code?: string }
      if (allowMissing && failure.status === 1) return ""
      const reason = failure.code === "ETIMEDOUT"
        ? `timed out after ${timeoutMs}ms; check remote connectivity`
        : "failed; check repository access, remote availability, and local changes/divergence"
      throw new Error(`Git ${operation} ${reason}`)
    }
  }

  // Inspect configuration, not resolution of @{u}: an upstream whose remote
  // tracking ref is missing must still attempt the pull and surface failures.
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], "branch detection")
  const merge = git(["config", "--get", `branch.${branch}.merge`], "upstream detection", true)
  if (!merge) return
  git(["pull", "--ff-only"], "pull")
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
  const output = readGit(["status", "--porcelain"], repoPath, "status", opts)
  return output.length > 0
}
