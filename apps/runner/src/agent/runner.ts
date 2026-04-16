import { spawn } from 'node:child_process'
import { execSync } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import type { AgentTask } from '@forge/shared'
import { config } from '../config.js'
import {
  updateTaskStatus,
  appendLog,
  setErrorMessage,
  setCommitSha,
} from '../db/queries.js'
import { removeEmitter, makeEvent } from './stream.js'
import { gitPull, gitCommit } from './git.js'

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
  // --- git pull before starting ---
  try {
    gitPull(task.repo)
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

  const startMsg = `[forge] starting claude agent in ${task.repo}\n`
  appendLog(task.id, startMsg)
  emitter.emit('event', makeEvent('log', startMsg))

  // Resolve the run user's uid/gid so we drop privileges before exec.
  // claude refuses --dangerously-skip-permissions when running as root.
  let uid: number | undefined
  let gid: number | undefined
  let claudeHome: string = process.env.HOME ?? '/root'
  try {
    const pw = execSync(`getent passwd ${config.claudeRunUser}`, { encoding: 'utf8' }).trim()
    const parts = pw.split(':')
    uid = parseInt(parts[2], 10)
    gid = parseInt(parts[3], 10)
    claudeHome = parts[5]
  } catch {
    console.warn(`[runner] CLAUDE_RUN_USER "${config.claudeRunUser}" not found — running as current user`)
  }

  const proc = spawn(
    'claude',
    ['--dangerously-skip-permissions', '-p', task.prompt],
    {
      cwd: task.repo,
      env: { ...process.env, HOME: claudeHome },
      ...(uid !== undefined ? { uid, gid } : {}),
    }
  )

  activeProcs.set(task.id, proc)

  // Buffer lines and flush to DB + SSE every 500ms to avoid hammering
  let buffer = ''
  let flushTimer: ReturnType<typeof setInterval> | null = null

  function flush() {
    if (!buffer) return
    const chunk = buffer
    buffer = ''
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
    // Final flush before wrapping up
    if (flushTimer) clearInterval(flushTimer)
    flush()

    activeProcs.delete(task.id)

    if (code === 0) {
      // Auto-commit if enabled
      if (config.autoCommit) {
        try {
          const sha = gitCommit(
            task.repo,
            `${config.commitMessagePrefix} ${task.prompt.slice(0, 72)}`
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
      const errMsg = `[forge] claude exited with code ${code}\n`
      appendLog(task.id, errMsg)
      setErrorMessage(task.id, `claude exited with code ${code}`)
      updateTaskStatus(task.id, 'failed')
      emitter.emit('event', makeEvent('error', errMsg))
    }

    emitter.emit('done')
    removeEmitter(task.id)
  })

  proc.on('error', (err) => {
    if (flushTimer) clearInterval(flushTimer)
    flush()
    activeProcs.delete(task.id)

    const errMsg = `[forge] failed to spawn claude: ${err.message}\n`
    appendLog(task.id, errMsg)
    setErrorMessage(task.id, err.message)
    updateTaskStatus(task.id, 'failed')
    emitter.emit('event', makeEvent('error', errMsg))
    emitter.emit('done')
    removeEmitter(task.id)
  })
}
