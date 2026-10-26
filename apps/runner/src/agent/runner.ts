import { spawn } from 'node:child_process'
import type { EventEmitter } from 'node:events'
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
import { providerCommand, executionIdentity, checkCodexLogin } from './provider.js'

// Active process handles keyed by taskId for SIGTERM support
const activeProcs = new Map<string, ReturnType<typeof spawn>>()

export function killTask(taskId: string): boolean {
  const proc = activeProcs.get(taskId)
  if (!proc) return false
  proc.kill('SIGTERM')
  return true
}

export function countActiveProcs(): number {
  return activeProcs.size
}

export async function runTask(task: AgentTask, emitter: EventEmitter): Promise<void> {
  const provider = task.provider ?? 'claude'
  let identity: ReturnType<typeof executionIdentity>
  try {
    identity = executionIdentity(provider === 'codex' ? config.codexRunUser : config.claudeRunUser)
    if (provider === 'codex') await checkCodexLogin(identity)
  } catch (err) {
    const message = `[forge] ${provider} setup failed: ${err instanceof Error ? err.message : 'unknown error'}`
    appendLog(task.id, message + '\n')
    setErrorMessage(task.id, message)
    updateTaskStatus(task.id, 'failed')
    emitter.emit('event', makeEvent('error', message))
    emitter.emit('done')
    removeEmitter(task.id)
    return
  }
  // A cancellation may arrive while the login probe is in flight.
  if (getTask(task.id)?.status !== 'queued') {
    emitter.emit('event', makeEvent('error', 'Task cancelled before launch'))
    emitter.emit('done')
    removeEmitter(task.id)
    return
  }
  // --- git pull before starting ---
  try {
    gitPull(task.repo, identity)
    const pullMsg = `[forge] git pull completed\n`
    appendLog(task.id, pullMsg)
    emitter.emit('event', makeEvent('log', pullMsg))
  } catch (err: any) {
    const msg = `[forge] git pull failed: ${err.message}\n`
    appendLog(task.id, msg)
    setErrorMessage(task.id, `git pull failed: ${err.message}`)
    updateTaskStatus(task.id, 'failed')
    emitter.emit('event', makeEvent('error', msg))
    emitter.emit('done')
    removeEmitter(task.id)
    return
  }

  updateTaskStatus(task.id, 'running')
  emitter.emit('event', makeEvent('status', 'running'))

  const startMsg = `[forge] starting ${provider} agent in ${task.repo}\n`
  appendLog(task.id, startMsg)
  emitter.emit('event', makeEvent('log', startMsg))

  const command = providerCommand(provider)
  const proc = spawn(
    command.command,
    provider === 'claude' ? [...command.args, task.prompt] : command.args,
    {
      cwd: task.repo,
      ...identity,
    }
  )

  activeProcs.set(task.id, proc)
  let settled = false
  // Tracks whether the child has actually exited, so the SIGKILL escalation
  // can be skipped once SIGTERM succeeds.
  let procExited = false
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null
  let killTimer: ReturnType<typeof setTimeout> | null = null
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

  // --- per-task timeout: SIGTERM then SIGKILL a hung agent ---
  // A hung `claude -p` / `codex` child would otherwise run forever, holding a
  // MAX_CONCURRENT_TASKS slot and blocking same-repo serialization until a
  // manual pm2 restart. On timeout we SIGTERM, wait a grace period, then SIGKILL.
  const parsedTimeout = Number.parseInt(process.env.TASK_TIMEOUT_MS ?? '', 10)
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 1800000
  const KILL_GRACE_MS = 10000
  timeoutTimer = setTimeout(() => {
    if (settled) return
    settled = true
    if (flushTimer) clearInterval(flushTimer)
    flush()

    const termMsg = `[forge] ${provider} agent exceeded timeout of ${timeoutMs}ms — sending SIGTERM\n`
    appendLog(task.id, termMsg)
    emitter.emit('event', makeEvent('log', termMsg))
    proc.kill('SIGTERM')

    // Escalate to SIGKILL if the child hasn't exited within the grace period.
    killTimer = setTimeout(() => {
      if (procExited) return
      const killMsg = `[forge] agent did not exit after SIGTERM — sending SIGKILL\n`
      appendLog(task.id, killMsg)
      emitter.emit('event', makeEvent('log', killMsg))
      proc.kill('SIGKILL')
    }, KILL_GRACE_MS)
    if (typeof killTimer.unref === 'function') killTimer.unref()

    // Free the concurrency slot immediately — the proc 'close' handler will
    // early-return on the `settled` guard, so do the cleanup here.
    activeProcs.delete(task.id)
    const errMsg = `${provider} timed out after ${timeoutMs}ms`
    appendLog(task.id, `[forge] ${errMsg}\n`)
    setErrorMessage(task.id, errMsg)
    updateTaskStatus(task.id, 'failed')
    emitter.emit('event', makeEvent('error', `[forge] ${errMsg}\n`))
    emitter.emit('done')
    removeEmitter(task.id)
  }, timeoutMs)
  if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()

  proc.stdout.on('data', (data: Buffer) => {
    buffer += data.toString()
  })

  proc.stderr.on('data', (data: Buffer) => {
    const text = data.toString().split('\n').map(l => l ? `[stderr] ${l}` : '').join('\n')
    buffer += text
  })

  proc.on('close', async (code) => {
    procExited = true
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (killTimer) clearTimeout(killTimer)
    if (settled) return
    settled = true
    // Final flush before wrapping up
    if (flushTimer) clearInterval(flushTimer)
    flush()

    activeProcs.delete(task.id)

    if (code === 0) {
      // Auto-commit if enabled
      if (task.autoCommit ?? config.autoCommit) {
        try {
          const sha = gitCommit(
            task.repo,
            `${config.commitMessagePrefix} ${task.prompt.slice(0, 72)}`, identity
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
    procExited = true
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (killTimer) clearTimeout(killTimer)
    if (settled) return
    settled = true
    if (flushTimer) clearInterval(flushTimer)
    flush()
    activeProcs.delete(task.id)

    const errMsg = `[forge] failed to spawn ${provider}: ${err.message}. Check installation and login for the configured runner user.\n`
    appendLog(task.id, errMsg)
    setErrorMessage(task.id, err.message)
    updateTaskStatus(task.id, 'failed')
    emitter.emit('event', makeEvent('error', errMsg))
    emitter.emit('done')
    removeEmitter(task.id)
  })
}
