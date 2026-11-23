import { spawn } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
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
import { providerCommand, executionIdentity, checkCodexLogin, readOnlyEnv } from './provider.js'
import { resolveReadOnlyIdentity } from '../capabilities.js'
import { prepareReadOnlyCopy, reportReadOnlyChanges } from './readonly.js'

interface ActiveProc {
  proc: ReturnType<typeof spawn>
  // Read-only agents are spawned in their own process group so we can kill the
  // whole group (including setsid/nohup children) rather than just the leader.
  detached: boolean
}

// Active process handles keyed by taskId for SIGTERM support
const activeProcs = new Map<string, ActiveProc>()

export function killTask(taskId: string): boolean {
  const entry = activeProcs.get(taskId)
  if (!entry) return false
  const { proc, detached } = entry
  if (detached && typeof proc.pid === 'number') {
    // Negative pid signals the entire process group.
    try {
      process.kill(-proc.pid, 'SIGTERM')
      return true
    } catch {
      // Group gone already — fall through to a direct signal.
    }
  }
  proc.kill('SIGTERM')
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
    // The agent NEVER runs in the real repo. Build a disposable, remote-less copy
    // owned by the isolated account. Any failure here fails the task before the
    // agent starts (fail closed) — the real repo is only ever read.
    try {
      tmpRoot = mkdtempSync(join(tmpdir(), 'forge-ro-'))
      const copyRepo = join(tmpRoot, 'repo')
      const prepared = prepareReadOnlyCopy(task.repo, copyRepo, { uid: identity.uid, gid: identity.gid })
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
  const proc = spawn(
    command.command,
    provider === 'claude' ? [...command.args, task.prompt] : command.args,
    {
      cwd,
      uid: identity.uid,
      gid: identity.gid,
      env: launchEnv,
      // Read-only: own process group → whole-group kill on cancel/close.
      ...(readOnly ? { detached: true } : {}),
    }
  )

  activeProcs.set(task.id, { proc, detached: readOnly })
  let settled = false
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
    flush()

    activeProcs.delete(task.id)

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
