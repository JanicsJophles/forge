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
  setVerification,
} from '../db/queries.js'
import { removeEmitter, makeEvent } from './stream.js'
import { gitPull, gitCommit } from './git.js'

import { verifyTask } from '../verify/index.js'
import { enforceCaps, resolveLimits } from '../verify/caps.js'

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
  // Resolve the run user's uid/gid FIRST. Every subsequent git op runs
  // as that user so we never leave root-owned objects under .git/ for the
  // forge user to choke on later (RAC-229).
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
  const runAs = uid !== undefined && gid !== undefined ? { uid, gid } : {}

  // --- git pull before starting ---
  try {
    gitPull(task.repo, runAs)
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

  const proc = spawn(
    'claude',
    ['--dangerously-skip-permissions', '-p', task.prompt],
    {
      detached: true,
      cwd: task.repo,
      env: { ...process.env, HOME: claudeHome },
      ...(uid !== undefined ? { uid, gid } : {}),
    }
  )

  activeProcs.set(task.id, proc)

  let cappedReason = ''
  let output = ''
  let spawnFailed = false
  const caps = enforceCaps(proc, resolveLimits(task.options ?? { repo: task.repo, prompt: task.prompt }, config.limits, config.maximum), reason => { cappedReason = reason })

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
    const text = caps.consume(data)
    output += text
    buffer += text
  })

  proc.stderr.on('data', (data: Buffer) => {
    const raw = caps.consume(data)
    output += raw
    const text = raw.split('\n').map(l => l ? `[stderr] ${l}` : '').join('\n')
    buffer += text
  })

  proc.on('close', async (code) => {
    caps.dispose()
    if (spawnFailed) return
    // Final flush before wrapping up
    if (flushTimer) clearInterval(flushTimer)
    flush()

    activeProcs.delete(task.id)

    if (cappedReason) {
      setErrorMessage(task.id, `capped: ${cappedReason}`)
      setVerification(task.id, { verified: false, checks: [{ name: 'caps', ok: false, detail: cappedReason }], diffStats: '', gate: null })
      updateTaskStatus(task.id, 'capped')
      emitter.emit('event', makeEvent('error', `capped: ${cappedReason}`))
    } else if (code === 0) {
      // Auto-commit if enabled
      if (config.autoCommit) {
        try {
          const sha = gitCommit(
            task.repo,
            `${config.commitMessagePrefix} ${task.prompt.slice(0, 72)}`,
            runAs
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

      const report = await verifyTask({ ...task.options, repo: task.repo, prompt: task.prompt, output }, config.verification, { ...runAs, env: { ...process.env, HOME: claudeHome } })
      setVerification(task.id, report)
      if (report.verified) {
        updateTaskStatus(task.id, 'completed')
        emitter.emit('event', makeEvent('complete', 'Task completed successfully'))
      } else {
        const reason = 'unverified: ' + report.checks.filter(c => !c.ok && !c.warning).map(c => c.detail).join('; ')
        setErrorMessage(task.id, reason)
        updateTaskStatus(task.id, 'unverified')
        emitter.emit('event', makeEvent('error', reason))
      }
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
    spawnFailed = true
    caps.dispose()
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
