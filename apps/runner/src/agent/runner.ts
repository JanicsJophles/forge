import { spawn } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { chownSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  prepareReadOnlyCopy,
  reportReadOnlyChanges,
  READONLY_TMP_PREFIX,
} from './readonly.js'

interface ActiveProc {
  proc: ReturnType<typeof spawn>
  // Read-only agents are spawned in their own process group so we can kill the
  // whole group (including setsid/nohup children) rather than just the leader.
  detached: boolean
  // Pending SIGTERM→SIGKILL escalation timer, if a termination is in flight.
  escalation?: ReturnType<typeof setTimeout>
}

// Active process handles keyed by taskId for SIGTERM support
const activeProcs = new Map<string, ActiveProc>()

// Signal a task's agent: the whole process group when detached (read-only), else the
// leader. Swallows ESRCH — the target may already be gone.
function signalTask(entry: ActiveProc, sig: NodeJS.Signals): void {
  const { proc, detached } = entry
  if (detached && typeof proc.pid === 'number') {
    try {
      process.kill(-proc.pid, sig)
      return
    } catch {
      // Group gone already — fall through to a direct signal.
    }
  }
  try {
    proc.kill(sig)
  } catch {
    // Process already exited.
  }
}

// Terminate a task, escalating SIGTERM → SIGKILL after the grace period so a process
// that ignores SIGTERM (or a process group with stubborn children) is still reaped.
export function killTask(taskId: string): boolean {
  const entry = activeProcs.get(taskId)
  if (!entry) return false
  signalTask(entry, 'SIGTERM')
  if (!entry.escalation) {
    entry.escalation = setTimeout(() => {
      if (activeProcs.get(taskId) === entry) signalTask(entry, 'SIGKILL')
    }, config.killGraceMs)
    entry.escalation.unref()
  }
  return true
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
        fail('[forge] read-only is not supported by this runner: READONLY_RUN_USER is not configured or the account does not exist')
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

  // Read-only agents get a MINIMAL env (explicit allowlist, no inherited tokens);
  // writable agents keep the existing env (tokens already stripped in identity.env).
  const launchEnv = readOnly
    ? readOnlyEnv(identity.home, identity.username, provider, {
        claudeConfigDir: config.readonlyClaudeConfigDir,
        codexHome: config.readonlyCodexHome,
      })
    : identity.env

  try {
    if (provider === 'codex') await checkCodexLogin({ uid: identity.uid, gid: identity.gid, env: launchEnv })
  } catch (err) {
    fail(`[forge] ${provider} setup failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    return
  }

  // A cancellation may arrive while the login probe is in flight.
  if (getTask(task.id)?.status !== 'queued') {
    emitter.emit('event', makeEvent('error', 'Task cancelled before launch'))
    emitter.emit('done')
    removeEmitter(task.id)
    return
  }

  // --- prepare the working directory the agent runs in ---
  let cwd = task.repo
  let tmpRoot: string | undefined
  let baseHead = ''
  let copyCleaned = false
  function cleanupCopy(): void {
    if (copyCleaned || !tmpRoot) return
    copyCleaned = true
    rmSync(tmpRoot, { recursive: true, force: true })
  }

  if (readOnly) {
    // Fail closed: the read-only account must not own the repo it is about to read —
    // otherwise it is not isolated from the writable account (finding 10).
    try {
      const repoOwner = statSync(task.repo).uid
      if (repoOwner === identity.uid) {
        fail('[forge] read-only is refused: the read-only account owns this repo (not isolated from the writable account)')
        return
      }
    } catch (err) {
      fail(`[forge] read-only: cannot stat repo: ${err instanceof Error ? err.message : 'unknown error'}`)
      return
    }

    // The agent NEVER runs in the real repo. Build a disposable, remote-less copy
    // owned by the isolated account, with ALL preparation (clone + overlay) done as
    // that unprivileged account in a child process — never as root. Any failure here
    // fails the task before the agent starts (fail closed); the real repo is read-only.
    try {
      tmpRoot = mkdtempSync(join(tmpdir(), READONLY_TMP_PREFIX))
      // Hand the temp root to the read-only account so it can create and traverse to
      // the copy by absolute path (claude's Read/Glob/Grep need this). Root ONLY
      // creates + chowns the dir; it never writes anything inside (finding 7). chown
      // is a no-op (and harmless) when the runner is not root, e.g. in tests.
      try {
        chownSync(tmpRoot, identity.uid, identity.gid)
      } catch {
        // Not running as root — the copy stays owned by the current user.
      }
      const copyRepo = join(tmpRoot, 'repo')
      const prepared = await prepareReadOnlyCopy(task.repo, copyRepo, {
        uid: identity.uid,
        gid: identity.gid,
        home: identity.home,
      })
      baseHead = prepared.baseHead
      cwd = copyRepo
    } catch (err) {
      cleanupCopy()
      fail(`[forge] read-only: failed to prepare disposable copy: ${err instanceof Error ? err.message : 'unknown error'}`)
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
  // Read-only resolves the binary to an absolute path on the fixed PATH, so the
  // launch does not depend on an attacker-influenceable PATH lookup. Writable keeps
  // its existing behaviour (bare name resolved via the identity env's PATH).
  let executable: string
  if (readOnly) {
    try {
      executable = resolveExecutable(command.command)
    } catch (err) {
      fail(`[forge] read-only: ${err instanceof Error ? err.message : 'provider binary not found'}`)
      cleanupCopy()
      return
    }
  } else {
    executable = command.command
  }

  const proc = spawn(
    executable,
    provider === 'claude' ? [...command.args, task.prompt] : command.args,
    {
      cwd,
      uid: identity.uid,
      gid: identity.gid,
      env: launchEnv,
      // Read-only: own process group → whole-group kill on cancel/close/timeout.
      ...(readOnly ? { detached: true } : {}),
    }
  )

  const activeEntry: ActiveProc = { proc, detached: readOnly }
  activeProcs.set(task.id, activeEntry)
  let settled = false

  // Wall-clock safety cap. On expiry, terminate (SIGTERM→SIGKILL) via killTask so a
  // wedged agent — or one holding stdout open through a backgrounded child so `close`
  // never fires — cannot run forever.
  const taskTimeout = setTimeout(() => {
    const msg = `[forge] task exceeded ${config.taskTimeoutMs}ms wall-clock limit — terminating\n`
    appendLog(task.id, msg)
    emitter.emit('event', makeEvent('log', msg))
    killTask(task.id)
  }, config.taskTimeoutMs)
  taskTimeout.unref()

  function clearTaskTimers(): void {
    clearTimeout(taskTimeout)
    if (activeEntry.escalation) clearTimeout(activeEntry.escalation)
  }
  proc.stdin.on('error', () => { /* early process exit is handled below */ })
  proc.stdin.end(provider === 'codex' ? task.prompt : undefined)

  // Buffer lines and flush to DB + SSE every 500ms to avoid hammering
  let buffer = ''
  let flushTimer: ReturnType<typeof setInterval> | null = null
  // Full accumulated log, kept in-memory so the stuckpoint-capture hook can
  // read the whole transcript at close without a DB round-trip. Capped to
  // avoid unbounded growth on very long runs.
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

  proc.stdout.on('data', (data: Buffer) => {
    buffer += data.toString()
  })

  proc.stderr.on('data', (data: Buffer) => {
    const text = data.toString().split('\n').map(l => l ? `[stderr] ${l}` : '').join('\n')
    buffer += text
  })

  proc.on('close', async (code) => {
    if (settled) return
    settled = true
    // Final flush before wrapping up
    if (flushTimer) clearInterval(flushTimer)
    clearTaskTimers()
    flush()

    activeProcs.delete(task.id)

    // Read-only leader exited: SIGKILL the whole group to reap any backgrounded
    // children it spawned (they share the read-only uid and could otherwise reach a
    // later task's copy). Harmless if the group is already empty.
    if (readOnly && typeof proc.pid === 'number') {
      try { process.kill(-proc.pid, 'SIGKILL') } catch { /* group already gone */ }
    }

    if (readOnly) {
      // The agent ran entirely inside the disposable copy. Record what it changed
      // there as INFORMATION ONLY — the real repo is never inspected or touched —
      // then discard the copy. No commit, no revert.
      try {
        const report = reportReadOnlyChanges(cwd, baseHead, { uid: identity.uid, gid: identity.gid })
        const reportMsg = `[forge] read-only report (changes confined to the disposable copy; the real repo and its remotes are untouched):\n${report}\n`
        appendLog(task.id, reportMsg)
        emitter.emit('event', makeEvent('log', reportMsg))
      } catch (err: any) {
        const errMsg = `[forge] read-only: could not summarize copy changes: ${err.message}\n`
        appendLog(task.id, errMsg)
        emitter.emit('event', makeEvent('log', errMsg))
      }
      cleanupCopy()

      if (code === 0) {
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
  })

  proc.on('error', (err) => {
    if (settled) return
    settled = true
    if (flushTimer) clearInterval(flushTimer)
    clearTaskTimers()
    flush()
    activeProcs.delete(task.id)
    cleanupCopy()

    const errMsg = `[forge] failed to spawn ${provider}: ${err.message}. Check installation and login for the configured runner user.\n`
    appendLog(task.id, errMsg)
    setErrorMessage(task.id, err.message)
    updateTaskStatus(task.id, 'failed')
    emitter.emit('event', makeEvent('error', errMsg))
    emitter.emit('done')
    removeEmitter(task.id)
  })
}
