import { spawn } from 'node:child_process'
import path from 'node:path'
import type { EventEmitter } from 'node:events'
import type { AgentTask } from '@forge/shared'
import { config } from '../config.js'
import {
  updateTaskStatus,
  getTask,
  appendLog,
  setErrorMessage,
  setCommitSha,
  setTaskChanges,
} from '../db/queries.js'
import { removeEmitter, makeEvent } from './stream.js'
import { gitPull, gitCommit } from './git.js'
import { captureChanges, headSha } from './changes.js'
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

// The runner does not serialize tasks per repo, and they share one working
// tree. Track which same-repo tasks were live together (pull -> snapshot) so a
// snapshot that may contain another task's edits says so.
const liveByRepo = new Map<string, Set<string>>()
const overlaps = new Map<string, Set<string>>()

function enterRepo(taskId: string, repo: string): void {
  const key = path.resolve(repo)
  const live = liveByRepo.get(key) ?? new Set<string>()
  for (const other of live) overlaps.get(other)?.add(taskId)
  overlaps.set(taskId, new Set(live))
  live.add(taskId)
  liveByRepo.set(key, live)
}

// Idempotent; returns the same-repo tasks that overlapped this one.
function leaveRepo(taskId: string, repo: string): string[] {
  const key = path.resolve(repo)
  liveByRepo.get(key)?.delete(taskId)
  if (liveByRepo.get(key)?.size === 0) liveByRepo.delete(key)
  const ids = [...(overlaps.get(taskId) ?? [])]
  overlaps.delete(taskId)
  return ids
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
  let baseSha: string | null = null
  enterRepo(task.id, task.repo)
  try {
    gitPull(task.repo, identity)
    baseSha = headSha(task.repo, identity)
    const pullMsg = `[forge] git pull completed\n`
    appendLog(task.id, pullMsg)
    emitter.emit('event', makeEvent('log', pullMsg))
  } catch (err: any) {
    const msg = `[forge] git pull failed: ${err.message}\n`
    appendLog(task.id, msg)
    setErrorMessage(task.id, `git pull failed: ${err.message}`)
    leaveRepo(task.id, task.repo)
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

  // Synchronous on purpose: runs before the task leaves 'running', so no other
  // runner code (e.g. the next task's git pull) interleaves with the snapshot.
  function recordChanges() {
    try {
      const changes = captureChanges(task.repo, baseSha, identity)
      const overlapping = leaveRepo(task.id, task.repo)
      setTaskChanges(task.id, overlapping.length ? { ...changes, overlapping_task_ids: overlapping } : changes)
      const msg = changes.error
        ? `[forge] ${changes.error}\n`
        : `[forge] captured ${changes.files.length}${changes.truncated ? '+' : ''} changed file(s)\n`
      appendLog(task.id, msg)
      emitter.emit('event', makeEvent('log', msg))
    } catch (err: any) {
      leaveRepo(task.id, task.repo)
      appendLog(task.id, `[forge] change capture failed: ${err?.message ?? 'unknown error'}\n`)
    }
  }

  proc.on('close', async (code) => {
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

      recordChanges()
      updateTaskStatus(task.id, 'completed')
      emitter.emit('event', makeEvent('complete', 'Task completed successfully'))
    } else {
      const errMsg = `[forge] ${provider} exited with code ${code}\n`
      appendLog(task.id, errMsg)
      setErrorMessage(task.id, `${provider} exited with code ${code}`)
      recordChanges()
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
    leaveRepo(task.id, task.repo)

    const errMsg = `[forge] failed to spawn ${provider}: ${err.message}. Check installation and login for the configured runner user.\n`
    appendLog(task.id, errMsg)
    setErrorMessage(task.id, err.message)
    updateTaskStatus(task.id, 'failed')
    emitter.emit('event', makeEvent('error', errMsg))
    emitter.emit('done')
    removeEmitter(task.id)
  })
}
