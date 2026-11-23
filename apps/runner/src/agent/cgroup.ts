// Cgroup v2 containment for read-only task process trees.
import {
  accessSync, constants,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const CG_MOUNT = '/sys/fs/cgroup'
const CG_PREFIX = 'forge-ro-'

// Resolve the runner's own cgroup v2 path from the unified "0::<path>" line.
function ownCgroupPath(): string | null {
  try {
    for (const line of readFileSync('/proc/self/cgroup', 'utf8').split('\n')) {
      const m = /^0::(.*)$/.exec(line)
      if (m) return m[1]
    }
  } catch {
    // No cgroupfs / not Linux.
  }
  return null
}

function killNode(dir: string): void {
  try {
    writeFileSync(join(dir, 'cgroup.kill'), '1')
    return
  } catch {
    // The node may already have been removed. Never fall back to PID enumeration.
  }
}

// rmdir a cgroup once its processes have drained. killAll is async in the kernel, so
// the last pid may still be reaping — retry on unref'd timers (NEVER block the event
// loop, finding B) and give up quietly after ~1s.
function removeNode(dir: string): void {
  let attempts = 0
  const tryRemove = (): void => {
    if (!existsSync(dir)) return
    try {
      rmdirSync(dir)
    } catch {
      if (++attempts < 20) setTimeout(tryRemove, 50).unref()
    }
  }
  tryRemove()
}

export interface TaskCgroup {
  readonly dir: string
  // Move a pid into this cgroup. Children it forks AFTER the move inherit the cgroup,
  // so moving the agent leader right after spawn captures the whole subsequent tree.
  addPid(pid: number): void
  // Kill every process in the cgroup (and sub-cgroups) — setsid children included.
  killAll(): void
  // Remove the (now-empty) cgroup node. Best-effort, non-blocking.
  remove(): void
}

// Create a dedicated cgroup v2 node for a task. Returns null (→ fall back to
// process-group kill) when the unified hierarchy is absent or we cannot create a node
// under our own cgroup (unprivileged / not delegated).
export function createTaskCgroup(taskId: string): TaskCgroup | null {
  const base = ownCgroupPath()
  if (base === null) return null
  const safeId = taskId.replace(/[^A-Za-z0-9_-]/g, '')
  const dir = join(CG_MOUNT, base, `${CG_PREFIX}${safeId}`)
  try {
    mkdirSync(dir)
    if (!existsSync(join(dir, 'cgroup.kill'))) { rmdirSync(dir); return null }
  } catch {
    return null // not root / not delegated — caller uses the fallback
  }
  return {
    dir,
    addPid(pid: number): void {
      writeFileSync(join(dir, 'cgroup.procs'), String(pid))
    },
    killAll(): void {
      killNode(dir)
    },
    remove(): void {
      removeNode(dir)
    },
  }
}

// Reap task cgroups orphaned by a previous runner (crash / pm2 restart / OOM). Kills
// any surviving processes in them, then removes the empty nodes. Best-effort; a node
// we cannot touch (e.g. not delegated to us) is simply skipped.
export function sweepStaleTaskCgroups(): number {
  const base = ownCgroupPath()
  if (base === null) return 0
  const parent = join(CG_MOUNT, base)
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return 0
  }
  let swept = 0
  for (const name of entries) {
    if (!name.startsWith(CG_PREFIX)) continue
    const dir = join(parent, name)
    try {
      killNode(dir)
      removeNode(dir)
      swept++
    } catch {
      // not ours / already gone
    }
  }
  return swept
}

export function containmentAvailable(): boolean {
  const group = createTaskCgroup(`probe-${process.pid}-${Math.random().toString(36).slice(2)}`)
  if (!group) return false
  try {
    // Test the actual migration permission with a disposable child, never the runner.
    execFileSync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], String(process.pid))", join(group.dir, 'cgroup.procs')], { timeout: 2000, stdio: 'ignore' })
    accessSync(join(group.dir, 'cgroup.kill'), constants.W_OK)
    return true
  } catch { return false } finally { group.remove() }
}
