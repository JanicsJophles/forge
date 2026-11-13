import { execFileSync } from "node:child_process"

interface RunOpts {
  uid?: number
  gid?: number
}

// Bind every Git subprocess to its supplied cwd, even when the runner was
// launched from a Git hook or another checkout. Never alter the parent env.
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // Repository hooks and helpers must never receive the runner mutation credential.
  delete env.FORGE_AUTH_TOKEN
  for (const key of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES",
  ]) delete env[key]
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" }
}

const GIT_WRITE_TIMEOUT_MS = 30_000

// Run a Git subprocess without a shell: the file and its arguments are passed
// as an argv array, so no value is ever parsed by a shell (no quoting, no
// injection). Pipe stdout and stderr so callers can inspect them on failure.
function exec(file: string, args: string[], cwd: string, opts: RunOpts = {}): string {
  return execFileSync(file, args, {
    cwd,
    env: gitEnvironment(),
    timeout: GIT_WRITE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
    ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
  }).trim()
}

// Read probes run on the request thread: cap each at two seconds so a stuck
// Git process (including a filesystem monitor hook) cannot block it indefinitely.
const GIT_READ_TIMEOUT_MS = 2_000

function readGit(args: string[], repoPath: string, operation: string, opts: RunOpts = {}, allowMissing = false): string {
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
  } catch (error) {
    const failure = error as { status?: number; code?: string; signal?: string }
    if (allowMissing && failure.status === 1 && !failure.code && !failure.signal) return ""
    // Never attach the original error: callers may persist or return this message,
    // and child-process errors can contain stderr, paths, URLs, and credentials.
    throw new Error(`Git ${operation} unavailable; read probe failed or exceeded 2000ms`)
  }
}

export function getCurrentBranch(repoPath: string): string {
  const ref = readGit(["symbolic-ref", "--quiet", "HEAD"], repoPath, "branch", {}, true)
  if (!ref) {
    readGit(["rev-parse", "--verify", "HEAD^{commit}"], repoPath, "branch")
    return "HEAD"
  }
  if (!ref.startsWith("refs/heads/")) {
    throw new Error("Git branch unavailable; read probe failed or exceeded 2000ms")
  }
  // A missing ref is an unborn branch; malformed refs or missing objects must
  // still fail. show-ref distinguishes absence (1) from corruption (128).
  readGit(["show-ref", "--verify", "--quiet", ref], repoPath, "branch", {}, true)
  return ref.slice("refs/heads/".length)
}

export interface HeadCommit {
  sha: string
  subject: string
}

// Read the checkout's current HEAD so a dispatcher can tell a stale clone from a
// current one. Throws (via readGit) when HEAD cannot be resolved — e.g. an empty
// repository with no commits — so callers can represent that as an absent head.
export function getHeadCommit(repoPath: string): HeadCommit {
  // %h = short SHA, %s = subject (the message's first line, so never multiline).
  // %x00 separates them to stay robust if a short SHA ever abuts the subject.
  const output = readGit(
    ["log", "-1", "--no-color", "--format=%h%x00%s", "HEAD"],
    repoPath,
    "head",
  )
  const separator = output.indexOf("\0")
  const sha = separator === -1 ? output : output.slice(0, separator)
  const subject = separator === -1 ? "" : output.slice(separator + 1)
  return { sha, subject }
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
    // argv array, no shell: repoPath is a single argument and is never parsed,
    // so paths with spaces or metacharacters cannot break out.
    execFileSync("chown", ["-R", `${opts.uid}:${opts.gid}`, repoPath], {
      env: gitEnvironment(),
      stdio: "ignore",
      timeout: GIT_WRITE_TIMEOUT_MS,
      killSignal: "SIGKILL",
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
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], "branch detection", true)
  if (!branch) {
    // Exit 1 can mean detached HEAD, but only a resolvable commit makes this
    // a valid checkout. Missing/corrupt HEAD must still fail before launch.
    git(["rev-parse", "--verify", "HEAD^{commit}"], "HEAD verification")
    return
  }
  const merge = git(["config", "--get", `branch.${branch}.merge`], "upstream detection", true)
  if (!merge) return
  git(["pull", "--ff-only"], "pull")
}

export function gitCommit(repoPath: string, message: string, opts: RunOpts = {}): string {
  // Sanitize every failure before it reaches persisted task errors. In particular,
  // a timeout must never be mistaken for a clean checkout based on hook output.
  function write(args: string[], operation: string): string {
    try {
      return exec("git", args, repoPath, opts)
    } catch (error) {
      const failure = error as { code?: string }
      const reason = failure.code === "ETIMEDOUT"
        ? "timed out after 30000ms; check Git hooks and repository filesystem responsiveness"
        : "failed; check repository permissions, Git hooks, and local changes"
      throw new Error(`Git ${operation} ${reason}`)
    }
  }

  // Stage tracked modifications only; do not commit a partial index if staging fails.
  write(["add", "-u"], "staging")
  // Exit status describes the index independently of locale or hook output.
  // Do not use HEAD: --cached also handles staged files in an unborn repository.
  try {
    execFileSync("git", ["diff", "--cached", "--quiet", "--exit-code"], {
      cwd: repoPath,
      env: gitEnvironment(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_READ_TIMEOUT_MS,
      killSignal: "SIGKILL",
      ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
      ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
    })
    return ""
  } catch (error) {
    const failure = error as { status?: number; code?: string; signal?: string | null }
    if (failure.status !== 1 || failure.code || failure.signal) {
      throw new Error("Git staged diff unavailable; read probe failed or exceeded 2000ms")
    }
  }
  write(["commit", "-m", message], "commit")
  return write(["rev-parse", "HEAD"], "commit SHA lookup")
}

export function hasUncommittedChanges(repoPath: string, opts: RunOpts = {}): boolean {
  const output = readGit(["status", "--porcelain"], repoPath, "status", opts)
  return output.length > 0
}
