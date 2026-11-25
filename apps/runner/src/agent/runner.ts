import { spawn } from 'node:child_process'
import type { EventEmitter } from 'node:events'
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
import { createWorkspace, finishWorkspace, workspaceLayout, type RunnerTask } from './workspace.js'

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

export async function runTask(task: RunnerTask, emitter: EventEmitter): Promise<void> {
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
  function log(line: string) {
    appendLog(task.id, line)
    emitter.emit('event', makeEvent('log', line))
  }
  // Workspace tasks: drop the worktree when nothing would be lost, otherwise keep it and say where it is.
  async function releaseWorkspace() {
    if (!task.workspace) return
    try {
      const outcome = await finishWorkspace(workspaceLayout, task.id, task.workspace, identity)
      log(outcome.removed ? `[forge] workspace removed (${outcome.reason})\n`
        : `[forge] workspace kept at ${task.repo} (${outcome.reason})\n`)
    } catch (err: any) {
      log(`[forge] workspace kept at ${task.repo} (cleanup failed: ${err.message})\n`)
    }
  }
  // --- prepare the checkout: a fresh worktree for workspace tasks, otherwise pull the existing clone ---
  try {
    if (task.workspace) {
      await createWorkspace(workspaceLayout, task.id, task.workspace, task.branch, identity)
      log(`[forge] workspace ready: ${task.repo} on ${task.branch} from origin/${task.workspace.base}\n`)
    } else {
      gitPull(task.repo, identity)
      log(`[forge] git pull completed\n`)
    }
  } catch (err: any) {
    const what = task.workspace ? 'workspace setup' : 'git pull'
    log(`[forge] ${what} failed: ${err.message}\n`)
    setErrorMessage(task.id, `${what} failed: ${err.message}`)
    updateTaskStatus(task.id, 'failed')
    emitter.emit('event', makeEvent('error', `${what} failed`))
    emitter.emit('done')
    removeEmitter(task.id)
    return
  }
  // A cancellation may also arrive while the checkout is prepared.
  if (getTask(task.id)?.status !== 'queued') {
    await releaseWorkspace()
    emitter.emit('event', makeEvent('error', 'Task cancelled before launch'))
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

      updateTaskStatus(task.id, 'completed')
      emitter.emit('event', makeEvent('complete', 'Task completed successfully'))
    } else {
      const errMsg = `[forge] ${provider} exited with code ${code}\n`
      appendLog(task.id, errMsg)
      setErrorMessage(task.id, `${provider} exited with code ${code}`)
      updateTaskStatus(task.id, 'failed')
      emitter.emit('event', makeEvent('error', errMsg))
    }

    await releaseWorkspace()
    emitter.emit('done')
    removeEmitter(task.id)
  })

  proc.on('error', (err) => {
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
    void releaseWorkspace().finally(() => {
      emitter.emit('done')
      removeEmitter(task.id)
    })
  })
}
