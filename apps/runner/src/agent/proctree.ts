import { execFileSync } from 'node:child_process'
import { readdirSync, readlinkSync } from 'node:fs'
import path from 'node:path'

// Killing an agent means killing everything it started. Signalling the agent's own process group is not enough:
// Claude Code runs each Bash tool call in a new process group, and Playwright detaches Chrome, so those survive a
// group kill. Instead: walk the tree by parent pid, signal every descendant and every group it leads.

export interface Proc {
  pid: number
  ppid: number
  pgid: number
  /** Start time as ps prints it: with pid it identifies one process, so a reused pid is never signalled. */
  start: string
}

export function listProcesses(): Proc[] {
  let out: string
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 10_000 })
  } catch {
    return []
  }
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start: m[4] })
  }
  return procs
}

/** The root (if alive) and all its descendants, from one snapshot. */
export function processTree(rootPid: number, procs: Proc[] = listProcesses()): Proc[] {
  const children = new Map<number, Proc[]>()
  for (const p of procs) {
    const list = children.get(p.ppid)
    if (list) list.push(p)
    else children.set(p.ppid, [p])
  }
  const tree: Proc[] = []
  const root = procs.find(p => p.pid === rootPid)
  if (root) tree.push(root)
  const queue = [rootPid]
  const seen = new Set(queue)
  while (queue.length) {
    for (const child of children.get(queue.shift() as number) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      tree.push(child)
      queue.push(child.pid)
    }
  }
  return tree
}

function send(target: number, signal: NodeJS.Signals): void {
  try { process.kill(target, signal) } catch { /* already gone or not ours */ }
}

/**
 * Signal the given processes and the groups they lead. Only groups whose leader is in the set are signalled, so an
 * unrelated group (the runner's own) is never touched. Members are matched by pid and start time against a fresh
 * listing first, so a pid reused since the snapshot is left alone.
 */
export function signalProcesses(members: Proc[], signal: NodeJS.Signals, current: Proc[] = listProcesses()): number {
  const alive = new Map(current.map(p => [p.pid, p]))
  const self = process.pid
  let sent = 0
  for (const m of members) {
    const now = alive.get(m.pid)
    if (!now || now.start !== m.start || m.pid === self) continue
    if (now.pgid === m.pid) send(-m.pid, signal)
    send(m.pid, signal)
    sent++
  }
  return sent
}

/** Processes still alive from a snapshot (same pid and start time). */
export function survivors(members: Proc[], current: Proc[] = listProcesses()): Proc[] {
  const alive = new Map(current.map(p => [p.pid, p.start]))
  return members.filter(m => alive.get(m.pid) === m.start)
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * SIGTERM the root, every descendant and every group they lead; after graceMs, SIGKILL whatever is left (plus
 * anything those survivors started meanwhile). `known` adds processes seen earlier that may have been reparented
 * away from the root since. Resolves with the processes that were still alive after SIGKILL.
 */
export async function killTree(rootPid: number | undefined, graceMs: number, known: Proc[] = []): Promise<Proc[]> {
  const merge = (a: Proc[], b: Proc[]) => {
    const map = new Map(a.map(p => [`${p.pid}|${p.start}`, p]))
    for (const p of b) map.set(`${p.pid}|${p.start}`, p)
    return [...map.values()]
  }
  let members = merge(known, rootPid ? processTree(rootPid) : [])
  signalProcesses(members, 'SIGTERM')
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && survivors(members).length) await sleep(Math.min(200, graceMs))
  const procs = listProcesses()
  const left = survivors(members, procs)
  for (const p of left) members = merge(members, processTree(p.pid, procs))
  signalProcesses(members, 'SIGKILL', procs)
  await sleep(100)
  return survivors(members)
}

/** Linux: pids whose working directory is dir or inside it (empty where /proc is unavailable). */
export function pidsWithCwdIn(dir: string, procRoot = '/proc'): number[] {
  const target = path.resolve(dir)
  let entries: string[]
  try { entries = readdirSync(procRoot) } catch { return [] }
  const pids: number[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid) continue
    let cwd: string
    try { cwd = readlinkSync(path.join(procRoot, entry, 'cwd')) } catch { continue }
    cwd = cwd.replace(/ \(deleted\)$/, '')
    if (cwd === target || cwd.startsWith(target + path.sep)) pids.push(pid)
  }
  return pids
}
