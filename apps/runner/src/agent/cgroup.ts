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
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const CG_MOUNT = '/sys/fs/cgroup'
const CG_PREFIX = 'forge-ro-'
let containmentFault = false

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

// Some service/LXC process cgroups cannot delegate resource controllers to
// children. Operators may select a delegated ancestor; the task still gets its
// own child and no existing process is moved or parent controller enabled.
function taskParent(): string | null {
  const configured = process.env.READONLY_CGROUP_PARENT
  if (configured) {
    const path = resolve(configured)
    if (path !== CG_MOUNT && !path.startsWith(CG_MOUNT + '/')) return null
    return path
  }
  const own = ownCgroupPath()
  return own === null ? null : join(CG_MOUNT, own)
}

function killNode(dir: string): boolean {
  try {
    writeFileSync(join(dir, 'cgroup.kill'), '1')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    containmentFault = true
    console.error(`[forge] cgroup teardown failed (${(error as NodeJS.ErrnoException).code ?? 'unknown'}); read-only launches disabled until restart`)
    return false
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
  killAll(): boolean
  readonly failure?: string
  // Remove the (now-empty) cgroup node. Best-effort, non-blocking.
  remove(): void
}

// Create a dedicated cgroup v2 node for a task. Returns null when containment
// is unavailable; read-only callers must refuse launch, never fall back.
export function createTaskCgroup(taskId: string): TaskCgroup | null {
  if (containmentFault) return null
  const base = taskParent()
  if (base === null) return null
  const safeId = taskId.replace(/[^A-Za-z0-9_-]/g, '')
  const dir = join(base, `${CG_PREFIX}${safeId}`)
  try {
    mkdirSync(dir)
    // Bound hostile preparation and agent processes as well as their lifetime.
    // Missing delegated controllers fails closed; never enable them on the live
    // runner's parent cgroup as a side effect of submitting a task.
    writeFileSync(join(dir, 'memory.max'), String(1024 * 1024 * 1024))
    writeFileSync(join(dir, 'memory.swap.max'), '0')
    writeFileSync(join(dir, 'pids.max'), '128')
    // Prove kill permission before any process can enter the group.
    writeFileSync(join(dir, 'cgroup.kill'), '1')
  } catch {
    try { rmdirSync(dir) } catch { /* missing or already removed */ }
    return null // not root / not delegated — caller must refuse read-only
  }
  let failure: string | undefined
  return {
    dir,
    get failure() { return failure },
    addPid(pid: number): void {
      writeFileSync(join(dir, 'cgroup.procs'), String(pid))
    },
    killAll(): boolean {
      const killed = killNode(dir)
      if (!killed) failure = 'read-only process containment teardown failed'
      return killed
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
  const parent = taskParent()
  if (parent === null) return 0
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
  if (containmentFault) return false
  const group = createTaskCgroup(`probe-${process.pid}-${Math.random().toString(36).slice(2)}`)
  if (!group) return false
  try {
    // Test the actual migration permission with a disposable child, never the runner.
    execFileSync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], String(process.pid))", join(group.dir, 'cgroup.procs')], { timeout: 2000, stdio: 'ignore' })
    accessSync(join(group.dir, 'cgroup.kill'), constants.W_OK)
    return true
  } catch { return false } finally { group.remove() }
}
