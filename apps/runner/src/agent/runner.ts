import { spawn, type ChildProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { chownSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentTask } from '@forge/shared'
import { config } from '../config.js'
import {
  updateTaskStatus,
  getTask,
  appendLog,
  setErrorMessage,
  setCommitSha,
} from '../db/queries.js'
import { removeEmitter, makeEvent } from './stream.js'
import { gitPull, gitCommit } from './git.js'
import {
  providerCommand,
  executionIdentity,
  checkCodexLogin,
  readOnlyEnv,
  resolveExecutable,
} from './provider.js'
import { resolveReadOnlyIdentity } from '../capabilities.js'
import {
  prepareReadOnlyBase,
  prepareReadOnlyCopy,
  reportReadOnlyChangesAsync,
  provisionReadOnlyHome,
  cleanupReadOnlyCopy,
  READONLY_TMP_PREFIX,
} from './readonly.js'
import { spawnContained } from './contained.js'
import { createTaskCgroup, type TaskCgroup } from './cgroup.js'

interface ActiveProc {
  proc: ChildProcess
  // Writable legacy tasks may use a process group; read-only uses a cgroup.
  detached: boolean
  // cgroup node containing the task's whole process tree. A cgroup kill reaps even a
  // setsid/daemonized child that escaped the process group (finding A). Null when the
  // runner handles a writable task. Read-only refuses launch without containment.
  cgroup?: TaskCgroup | null
  // Pending SIGTERM→SIGKILL escalation timer, if a termination is in flight.
  escalation?: ReturnType<typeof setTimeout>
}

// Active process handles keyed by taskId for SIGTERM support
const activeProcs = new Map<string, ActiveProc>()

// Signal a task's agent: the whole process group when detached (read-only), else the
// leader. Swallows ESRCH — the target may already be gone. On SIGKILL also empties the
// cgroup, which reaps setsid/daemonized children the process group never contained.
function signalTask(entry: ActiveProc, sig: NodeJS.Signals): void {
  const { proc, detached, cgroup } = entry
  if (detached && typeof proc?.pid === 'number') {
    try {
      process.kill(-proc.pid, sig)
    } catch {
      // Group gone already — fall through to a direct signal.
      try { proc.kill(sig) } catch { /* process already exited */ }
    }
  } else {
    try { proc?.kill(sig) } catch { /* process already exited */ }
  }
  // The cgroup is the only mechanism that reaches a child that left the process group
  // via setsid(); use it on the hard kill so nothing survives (finding A).
  if (cgroup && sig === 'SIGKILL') cgroup.killAll()
}

// Terminate a task, escalating SIGTERM → SIGKILL after the grace period so a process
// that ignores SIGTERM (or a process group with stubborn children) is still reaped.
export function killTask(taskId: string): boolean {
  const entry = activeProcs.get(taskId)
  if (!entry) return false
  if (entry.cgroup) entry.cgroup.killAll()
  signalTask(entry, 'SIGTERM')
  if (!entry.escalation) {
    entry.escalation = setTimeout(() => {
      if (activeProcs.get(taskId) === entry) signalTask(entry, 'SIGKILL')
    }, config.killGraceMs)
    entry.escalation.unref()
  }
  return !entry.cgroup?.failure
}

export function countActiveProcs(): number {
  return activeProcs.size
}

export async function runTask(task: AgentTask, emitter: EventEmitter): Promise<void> {
  const provider = task.provider ?? 'claude'
  const readOnly = task.readOnly ?? false

  function fail(message: string): void {
    appendLog(task.id, message + '\n')
    setErrorMessage(task.id, message)
    updateTaskStatus(task.id, 'failed')
    emitter.emit('event', makeEvent('error', message))
    emitter.emit('done')
    removeEmitter(task.id)
  }

  // --- resolve the account the agent runs as ---
  let identity: ReturnType<typeof executionIdentity>
  try {
    if (readOnly) {
      // Fail closed: read-only must have its dedicated, isolated account.
      const ro = resolveReadOnlyIdentity()
      if (!ro) {
        fail('[forge] read-only is not supported by this runner: containment is unavailable; configure a pre-execution cgroup launcher before enabling read-only tasks')
        return
      }
      identity = ro
    } else {
      identity = executionIdentity(provider === 'codex' ? config.codexRunUser : config.claudeRunUser)
    }
  } catch (err) {
    fail(`[forge] ${provider} setup failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    return
  }

  // --- per-task state (read-only only) ---
  let cwd = task.repo
  let tmpRoot: string | undefined
  let baseHead = ''
  let ephemeralHome: string | undefined
  let cgroup: TaskCgroup | null = null

  // Remove the disposable copy without ever letting root recurse a tree the read-only
  // account could swap for a symlink mid-delete (finding D). Idempotent + never throws.
  let copyCleaned = false
  let copyHandedOff = false
  async function cleanupCopy(): Promise<void> {
    if (copyCleaned || !tmpRoot) return
    copyCleaned = true
    if (!copyHandedOff) {
      // No child has ever received this private root-owned directory. It contains
      // only paths created by trusted provisioning; no agent can race this cleanup.
      try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* leave private setup state for operator cleanup */ }
    } else {
      await cleanupReadOnlyCopy(tmpRoot, { uid: identity.uid, gid: identity.gid })
    }
    cgroup?.remove()
  }

  if (readOnly) {
    // Fail closed: the read-only account must not own the repo (or its .git) it is
    // about to read — otherwise it is not isolated from the writable account (H/10).
    try {
      const repoOwner = statSync(task.repo).uid
      let gitOwner = repoOwner
      try {
        gitOwner = statSync(join(task.repo, '.git')).uid
      } catch {
        // `.git` may be a file (linked worktree) or absent; the top-level check stands.
      }
      if (repoOwner === identity.uid || gitOwner === identity.uid) {
        fail('[forge] read-only is refused: the read-only account owns this repo or its .git (not isolated from the writable account)')
        return
      }
    } catch (err) {
      fail(`[forge] read-only: cannot stat repo: ${err instanceof Error ? err.message : 'unknown error'}`)
      return
    }

    // One cgroup per read-only task: it contains the prep worker, the agent, the report
    // worker, and anything they fork — so a single cgroup kill reaps the whole tree,
    // including setsid children a process-group kill would miss (finding A).
    cgroup = createTaskCgroup(task.id)
    if (!cgroup) { fail('[forge] read-only containment unavailable'); return }

    // The agent NEVER runs in the real repo. Build a disposable, remote-less copy under
    // the root-owned base dir (never /tmp — finding D), owned by the isolated account,
    // with ALL preparation done as that unprivileged account in a child process.
    try {
      prepareReadOnlyBase(config.readonlyBaseDir)
      tmpRoot = mkdtempSync(join(config.readonlyBaseDir, READONLY_TMP_PREFIX))
      // Keep mode-0700 root ownership until credential provisioning has finished.
      // Handing this dir to the shared agent uid earlier lets another task replace
      // home/config paths while the privileged parent is still writing them.
    } catch (err) {
      cgroup?.remove()
      fail(`[forge] read-only: cannot create disposable copy dir under ${config.readonlyBaseDir}: ${err instanceof Error ? err.message : 'unknown error'}`)
      return
    }
  }

  // Read-only agents get a MINIMAL env (explicit allowlist, no inherited tokens) rooted
  // at a PER-TASK EPHEMERAL HOME seeded with a per-task copy of the provider's auth
  // (findings E/F) — so a read-only run can neither read a planted ~/.gitconfig nor leave
  // one behind for the next task. Writable agents keep the existing env.
  let launchEnv: NodeJS.ProcessEnv
  if (readOnly) {
    // Pristine auth source: the explicit override if set, else the account's own dir.
    const authSrc = provider === 'claude'
      ? (config.readonlyClaudeConfigDir ?? join(identity.home, '.claude'))
      : (config.readonlyCodexHome ?? join(identity.home, '.codex'))
    try {
      const eph = provisionReadOnlyHome(tmpRoot!, { uid: identity.uid, gid: identity.gid }, provider, authSrc)
      ephemeralHome = eph.home
      launchEnv = readOnlyEnv(eph.home, identity.username, provider, {
        claudeConfigDir: provider === 'claude' ? eph.configDir : undefined,
        codexHome: provider === 'codex' ? eph.configDir : undefined,
      })
      // Last privileged write below the task root: after this handoff all workers
      // and recursive cleanup run only as the read-only identity.
      chownSync(tmpRoot!, identity.uid, identity.gid)
      copyHandedOff = true
    } catch (err) {
      await cleanupCopy()
      fail(`[forge] read-only home setup failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      return
    }
  } else {
    launchEnv = identity.env
  }

  try {
    if (provider === 'codex' && !readOnly) await checkCodexLogin({ uid: identity.uid, gid: identity.gid, env: launchEnv })
  } catch (err) {
    if (readOnly) await cleanupCopy()
    fail(`[forge] ${provider} setup failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    return
  }

  // A cancellation may arrive while the login probe is in flight.
  if (getTask(task.id)?.status !== 'queued') {
    if (readOnly) await cleanupCopy()
    emitter.emit('event', makeEvent('error', 'Task cancelled before launch'))
    emitter.emit('done')
    removeEmitter(task.id)
    return
  }

  // --- prepare the working directory the agent runs in ---
  if (readOnly) {
    // Register the prep worker so a DELETE arriving during the (up to two-minute) prep
    // actually kills it rather than being lost (finding G). The prep child leads its own
    // group; killTask signals the group (and empties the cgroup on escalation).
    const prepEntry: ActiveProc = { proc: undefined as unknown as ChildProcess, detached: false, cgroup }
    activeProcs.set(task.id, prepEntry)
    try {
      const copyRepo = join(tmpRoot!, 'repo')
      const prepared = await prepareReadOnlyCopy(
        task.repo,
        copyRepo,
        { uid: identity.uid, gid: identity.gid, home: ephemeralHome },
        {
          timeoutMs: config.readonlyPrepTimeoutMs,
          onSpawn: (child) => { prepEntry.proc = child },
          cgroup: cgroup!,
          requireReadOnlySource: true,
        },
      )
      baseHead = prepared.baseHead
      cwd = copyRepo
    } catch (err) {
      cgroup?.killAll()
      activeProcs.delete(task.id)
      if (prepEntry.escalation) clearTimeout(prepEntry.escalation)
      await cleanupCopy()
      fail(`[forge] read-only: failed to prepare disposable copy: ${err instanceof Error ? err.message : 'unknown error'}`)
      return
    }
    if (cgroup?.failure) {
      activeProcs.delete(task.id)
      if (prepEntry.escalation) clearTimeout(prepEntry.escalation)
      await cleanupCopy()
      fail(cgroup.failure)
      return
    }
    activeProcs.delete(task.id)
    if (prepEntry.escalation) clearTimeout(prepEntry.escalation)

    // Re-check: a cancel may have arrived during prep. If the task is no longer queued,
    // abort BEFORE the agent starts (finding G) — the DELETE handler marks a cancelled
    // queued task 'failed', so we must not override it or launch the agent.
    if (getTask(task.id)?.status !== 'queued') {
      await cleanupCopy()
      emitter.emit('event', makeEvent('error', 'Task cancelled during preparation'))
      emitter.emit('done')
      removeEmitter(task.id)
      return
    }
  } else {
    // --- git pull before starting (writable tasks only; never mutate the real
    //     repo for read-only runs) ---
    try {
      gitPull(task.repo, { uid: identity.uid, gid: identity.gid })
      const pullMsg = `[forge] git pull completed\n`
      appendLog(task.id, pullMsg)
      emitter.emit('event', makeEvent('log', pullMsg))
    } catch (err: any) {
      fail(`[forge] git pull failed: ${err.message}`)
      return
    }
  }

  updateTaskStatus(task.id, 'running')
  emitter.emit('event', makeEvent('status', 'running'))

  const startMsg = `[forge] starting ${provider} agent in ${cwd}${readOnly ? ' (read-only, disposable copy)' : ''}\n`
  appendLog(task.id, startMsg)
  emitter.emit('event', makeEvent('log', startMsg))

  const command = providerCommand(provider, readOnly)
  // Read-only resolves the binary to an absolute path on the fixed PATH, so the launch
  // does not depend on an attacker-influenceable PATH lookup. Writable keeps its
  // existing behaviour (bare name resolved via the identity env's PATH).
  let executable: string
  if (readOnly) {
    try {
      executable = resolveExecutable(command.command)
    } catch (err) {
      await cleanupCopy()
      fail(`[forge] read-only: ${err instanceof Error ? err.message : 'provider binary not found'}`)
      return
    }
  } else {
    executable = command.command
  }

  let proc: ChildProcess
  try {
    const args = provider === 'claude' ? [...command.args, task.prompt] : command.args
    proc = readOnly
      ? spawnContained(cgroup!, executable, args, { cwd, uid: identity.uid, gid: identity.gid, env: launchEnv })
      : spawn(executable, args, { cwd, uid: identity.uid, gid: identity.gid, env: launchEnv })
  } catch (err) {
    cgroup?.killAll()
    await cleanupCopy()
    fail(`[forge] failed to launch agent: ${err instanceof Error ? err.message : 'unknown error'}`)
    return
  }

  const activeEntry: ActiveProc = { proc, detached: false, cgroup }
  activeProcs.set(task.id, activeEntry)
  let settled = false
  let exitCode: number | null = null
  let settleGraceTimer: ReturnType<typeof setTimeout> | undefined

  // Wall-clock safety cap — READ-ONLY tasks only, and only when configured > 0 (finding
  // J). Writable tasks are NEVER wall-clock-capped: their behaviour is exactly as it was
  // before the read-only work. On expiry, terminate (SIGTERM→SIGKILL) via killTask.
  let taskTimeout: ReturnType<typeof setTimeout> | undefined
  if (readOnly && config.taskTimeoutMs > 0) {
    taskTimeout = setTimeout(() => {
      const msg = `[forge] task exceeded ${config.taskTimeoutMs}ms wall-clock limit — terminating\n`
      appendLog(task.id, msg)
      emitter.emit('event', makeEvent('log', msg))
      killTask(task.id)
    }, config.taskTimeoutMs)
    taskTimeout.unref()
  }

  function clearTaskTimers(): void {
    if (taskTimeout) clearTimeout(taskTimeout)
    if (settleGraceTimer) clearTimeout(settleGraceTimer)
    if (activeEntry.escalation) clearTimeout(activeEntry.escalation)
  }

  // Reap the whole process tree. The cgroup reaches setsid/daemonized children that a
  // process-group kill misses. Read-only never falls back to a process-group claim.
  function reapTree(): void {
    cgroup?.killAll()
  }

  proc.stdin!.on('error', () => { /* early process exit is handled below */ })
  proc.stdin!.end(provider === 'codex' ? task.prompt : undefined)

  // Buffer lines and flush to DB + SSE every 500ms to avoid hammering
  let buffer = ''
  let flushTimer: ReturnType<typeof setInterval> | null = null
  // Full accumulated log, kept in-memory so the stuckpoint-capture hook can read the
  // whole transcript at close without a DB round-trip. Capped to avoid unbounded growth.
  const MAX_CAPTURE_LOG = 256 * 1024 // 256KB
  let fullLog = ''

  function flush() {
    if (!buffer) return
    const chunk = buffer
    buffer = ''
    if (fullLog.length < MAX_CAPTURE_LOG) {
      fullLog += chunk
    }
    appendLog(task.id, chunk)
    emitter.emit('event', makeEvent('log', chunk))
  }

  flushTimer = setInterval(flush, 500)

  let readonlyLogChars = 0
  const MAX_READONLY_LOG = 16 * 1024 * 1024
  function appendOutput(text: string): void {
    if (!readOnly) { buffer += text; return }
    const remaining = MAX_READONLY_LOG - readonlyLogChars
    if (remaining <= 0) return
    const bounded = text.slice(0, remaining)
    buffer += bounded
    readonlyLogChars += bounded.length
    if (readonlyLogChars === MAX_READONLY_LOG) buffer += '\n[forge] read-only log capped at 16 MiB\n'
  }
  proc.stdout!.on('data', (data: Buffer) => {
    appendOutput(data.toString())
  })

  proc.stderr!.on('data', (data: Buffer) => {
    const text = data.toString().split('\n').map(l => l ? `[stderr] ${l}` : '').join('\n')
    appendOutput(text)
  })

  // Finalise the task exactly once. Driven by 'close' normally; for read-only tasks a
  // grace timer armed on 'exit' also calls it, so a setsid child holding stdout open
  // cannot keep the task "running" forever (finding A).
  async function settle(code: number | null): Promise<void> {
    if (settled) return
    settled = true
    if (flushTimer) clearInterval(flushTimer)
    clearTaskTimers()
    flush()
    activeProcs.delete(task.id)

    if (readOnly) {
      // Leader done: reap any backgrounded/ setsid children (they share the read-only
      // uid and could otherwise reach a later task's copy).
      reapTree()

      // Report what the agent changed inside the disposable copy as INFORMATION ONLY —
      // the real repo is never inspected or touched. Runs in a THROWAWAY CHILD with a
      // hard timeout + whole-tree kill, so a planted filter/fsmonitor cannot block the
      // runner's event loop (finding B). reportReadOnlyChangesAsync never rejects.
      const report = await reportReadOnlyChangesAsync(cwd, baseHead, {
        uid: identity.uid,
        gid: identity.gid,
        home: ephemeralHome,
        cgroup: cgroup!,
        killTree: () => cgroup?.killAll(),
      })
      const reportMsg = `[forge] read-only report (changes confined to the disposable copy; the real repo and its remotes are untouched):\n${report}\n`
      appendLog(task.id, reportMsg)
      emitter.emit('event', makeEvent('log', reportMsg))

      await cleanupCopy()

      if (code === 0 && !cgroup?.failure) {
        updateTaskStatus(task.id, 'completed')
        emitter.emit('event', makeEvent('complete', 'Task completed successfully'))
      } else {
        const errMsg = cgroup?.failure ? `[forge] ${cgroup.failure}\n` : `[forge] ${provider} exited with code ${code}\n`
        appendLog(task.id, errMsg)
        setErrorMessage(task.id, `${provider} exited with code ${code}`)
        updateTaskStatus(task.id, 'failed')
        emitter.emit('event', makeEvent('error', errMsg))
      }
      emitter.emit('done')
      removeEmitter(task.id)
      return
    }

    if (code === 0) {
      // Auto-commit if enabled
      if (task.autoCommit ?? config.autoCommit) {
        try {
          const sha = gitCommit(
            task.repo,
            `${config.commitMessagePrefix} ${task.prompt.slice(0, 72)}`, { uid: identity.uid, gid: identity.gid }
          )
          if (sha) {
            setCommitSha(task.id, sha)
            const commitMsg = `[forge] committed: ${sha}\n`
            appendLog(task.id, commitMsg)
            emitter.emit('event', makeEvent('log', commitMsg))
          } else {
            const noopMsg = `[forge] no changes to commit\n`
            appendLog(task.id, noopMsg)
            emitter.emit('event', makeEvent('log', noopMsg))
          }
        } catch (err: any) {
          const errMsg = `[forge] git commit failed: ${err.message}\n`
          appendLog(task.id, errMsg)
          emitter.emit('event', makeEvent('log', errMsg))
        }
      }

      updateTaskStatus(task.id, 'completed')
      emitter.emit('event', makeEvent('complete', 'Task completed successfully'))
    } else {
      const errMsg = `[forge] ${provider} exited with code ${code}\n`
      appendLog(task.id, errMsg)
      setErrorMessage(task.id, `${provider} exited with code ${code}`)
      updateTaskStatus(task.id, 'failed')
      emitter.emit('event', makeEvent('error', errMsg))
    }

    emitter.emit('done')
    removeEmitter(task.id)
  }

  // Read-only ONLY: the leader exiting is the authoritative "done" signal. Reap the
  // tree immediately (so a setsid child cannot hold stdout open), then — if `close`
  // still has not fired after the grace period — force the streams shut and settle
  // anyway (finding A). Writable tasks keep their exact prior behaviour (close + error).
  if (readOnly) {
    proc.on('exit', (code) => {
      exitCode = code
      reapTree()
      if (!settled && !settleGraceTimer) {
        settleGraceTimer = setTimeout(() => {
          try { proc.stdout?.destroy() } catch { /* already closed */ }
          try { proc.stderr?.destroy() } catch { /* already closed */ }
          void settle(exitCode)
        }, config.killGraceMs)
        settleGraceTimer.unref()
      }
    })
  }

  proc.on('close', (code) => { void settle(code ?? exitCode) })

  proc.on('error', (err) => {
    if (settled) return
    settled = true
    if (flushTimer) clearInterval(flushTimer)
    clearTaskTimers()
    flush()
    activeProcs.delete(task.id)
    reapTree()
    void cleanupCopy()

    const errMsg = `[forge] failed to spawn ${provider}: ${err.message}. Check installation and login for the configured runner user.\n`
    appendLog(task.id, errMsg)
    setErrorMessage(task.id, err.message)
    updateTaskStatus(task.id, 'failed')
    emitter.emit('event', makeEvent('error', errMsg))
    emitter.emit('done')
    removeEmitter(task.id)
  })
}
