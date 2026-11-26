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
import { ClaudeStreamParser, type ClaudeOutcome } from './claude-stream.js'
import { createWorkspace, finishWorkspace, workspaceLayout, type RunnerTask } from './workspace.js'
import { StallWatchdog, watchdogLimits, watchdogIntervalMs, type StallVerdict } from './watchdog.js'
import { killTree, processTree, pidsWithCwdIn, survivors, type Proc } from './proctree.js'

// Active process handles keyed by taskId for SIGTERM support
const activeProcs = new Map<string, ReturnType<typeof spawn>>()
const KILL_ESCALATION_MS = Number(process.env.FORGE_KILL_GRACE_MS) || 15_000

export function killTask(taskId: string): boolean {
  const proc = activeProcs.get(taskId)
  if (!proc) return false
  // Every descendant and the groups they lead: Bash tool shells and browsers run in groups of their own.
  void killTree(proc.pid, KILL_ESCALATION_MS)
  return true
}

// Tasks have no PR or abort fields yet: the outcome goes into the log as one line callers can match.
function outcomeLine(outcome: ClaudeOutcome | undefined): string {
  if (outcome?.prUrl) return `[forge] outcome: PR ${outcome.prUrl}\n`
  if (outcome?.aborted) return `[forge] outcome: ABORTED ${outcome.aborted}\n`
  return ''
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
      // Own process group, so the agent never shares the runner's group when its tree is signalled.
      detached: true,
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

  // A task that stops producing output, or finishes but never exits, is killed and reported instead of
  // sitting in `running` forever.
  const limits = watchdogLimits({ stallMinutes: task.stallMinutes, exitGraceMinutes: task.exitGraceMinutes })
  const watchdog = new StallWatchdog(limits)
  let verdict: StallVerdict | null = null
  // Everything the agent has started, refreshed each tick: a shell orphaned when its parent exits is reparented
  // away from the agent's tree but still has to die with the task.
  let seen: Proc[] = []
  const watchdogTimer = setInterval(() => {
    if (proc.pid) seen = [...survivors(seen), ...processTree(proc.pid).filter(p => p.pid !== proc.pid)]
    if (verdict) return
    verdict = watchdog.check()
    if (!verdict) return
    buffer += `[forge] watchdog: ${verdict.message}; killing the agent's process tree\n`
    flush()
    void killTree(proc.pid, KILL_ESCALATION_MS, seen)
  }, watchdogIntervalMs(limits))
  watchdogTimer.unref()

  // After the agent is gone: anything it left running (tracked descendants, and for a per-task workspace anything
  // still working inside it) is killed before the workspace is released.
  async function reapLeftovers() {
    const alive = survivors(seen)
    if (alive.length) await killTree(undefined, KILL_ESCALATION_MS, alive)
    const inWorkspace = task.workspace ? pidsWithCwdIn(task.repo) : []
    for (const pid of inWorkspace) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    if (alive.length || inWorkspace.length) {
      log(`[forge] reaped ${alive.length} leftover process(es)${inWorkspace.length ? ` and ${inWorkspace.length} still in the workspace` : ''}\n`)
    }
  }

  // Claude prints stream-json events: each becomes a short log line, never raw JSON. Codex output is kept as is.
  const claudeStream = provider === 'claude' ? new ClaudeStreamParser() : null
  if (claudeStream) proc.stdout.setEncoding('utf8') // decodes characters split across chunks
  proc.stdout.on('data', (data: Buffer | string) => {
    watchdog.output()
    const before = claudeStream?.outcome
    buffer += claudeStream ? claudeStream.push(String(data)) : data.toString()
    if (claudeStream && claudeStream.outcome !== before) watchdog.result()
  })

  proc.stderr.on('data', (data: Buffer) => {
    watchdog.output()
    const text = data.toString().split('\n').map(l => l ? `[stderr] ${l}` : '').join('\n')
    buffer += text
  })

  proc.on('close', async (code) => {
    if (settled) return
    settled = true
    clearInterval(watchdogTimer)
    // Final flush before wrapping up
    if (flushTimer) clearInterval(flushTimer)
    if (claudeStream) buffer += claudeStream.end() + outcomeLine(claudeStream.outcome)
    flush()

    activeProcs.delete(task.id)

    // Killed only because it would not exit after a successful result: the agent's work stands.
    const finishedThenKilled = verdict?.kind === 'lingering' && claudeStream?.outcome !== undefined
      && !claudeStream.outcome.isError
    if (code === 0 || finishedThenKilled) {
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
      const reason = verdict ? `watchdog: ${verdict.message}` : `${provider} exited with code ${code}`
      const errMsg = `[forge] ${reason}\n`
      appendLog(task.id, errMsg)
      setErrorMessage(task.id, reason)
      updateTaskStatus(task.id, 'failed')
      emitter.emit('event', makeEvent('error', errMsg))
    }

    await reapLeftovers()
    await releaseWorkspace()
    emitter.emit('done')
    removeEmitter(task.id)
  })

  proc.on('error', (err) => {
    if (settled) return
    settled = true
    clearInterval(watchdogTimer)
    if (flushTimer) clearInterval(flushTimer)
    if (claudeStream) buffer += claudeStream.end()
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
