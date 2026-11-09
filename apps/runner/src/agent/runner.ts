import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { stderrLines } from './stderr-lines.js'
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
import { exitReason } from './exit-reason.js'
import { providerDetached, hasProcessGroup, signalProvider } from './process-group.js'

// Bounds are UTF-16 code units, matching JavaScript string length.
const MAX_PENDING_OUTPUT = 16 * 1024
const DECODE_INPUT_BYTES = 1024

// Never persist provider diagnostics, arguments, paths, or arbitrary codes.
function launchFailureDetail(err: unknown): string {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
  const reasons: Record<string, string> = {
    EACCES: 'EACCES: check executable permissions and the configured runner user',
    EPERM: 'EPERM: check executable permissions and the configured runner user',
    ENOENT: 'ENOENT: check the provider installation and repository directory',
    EINVAL: 'EINVAL: check provider launch options',
    ERR_INVALID_ARG_TYPE: 'ERR_INVALID_ARG_TYPE: check provider launch option types',
    ERR_INVALID_ARG_VALUE: 'ERR_INVALID_ARG_VALUE: check provider launch option values',
    ERR_OUT_OF_RANGE: 'ERR_OUT_OF_RANGE: check provider launch option ranges',
  }
  const detail = code && Object.hasOwn(reasons, code)
    ? reasons[code] : 'check provider installation, repository directory, and runner launch options'
  return detail
}

function loginFailureDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : ''
  // checkCodexLogin constructs these reasons without child output.
  if (message === 'Codex CLI is unavailable for the configured runner account' ||
      message === 'Codex login check timed out' ||
      /^Codex login probe failed \(exit code (?:-?\d+|unknown)\)$/.test(message) ||
      /^Codex login probe failed \(signal (?:SIG[A-Z0-9]+|unknown)\)$/.test(message)) return message
  return 'Codex login probe failed; check CLI installation and login for the configured runner account'
}

// Active termination callbacks stay registered until the child closes.
const activeProcs = new Map<string, () => void>()

export function killTask(taskId: string): boolean {
  const terminate = activeProcs.get(taskId)
  if (!terminate) return false
  terminate()
  return true
}

export function countActiveProcs(): number {
  return activeProcs.size
}

// Runtime injection keeps lifecycle tests independent of real agent processes.
const runtime = { spawn, executionIdentity, gitPull, gitCommit, setTimeout, clearTimeout, checkCodexLogin }
export async function runTask(
  task: AgentTask, emitter: EventEmitter,
  deps: Omit<typeof runtime, 'checkCodexLogin'> & { checkCodexLogin?: typeof checkCodexLogin; signalProvider?: typeof signalProvider } = runtime,
): Promise<void> {
  const provider = task.provider ?? 'claude'
  let identity: ReturnType<typeof executionIdentity>
  let setupOperation = 'runner identity'
  try {
    identity = deps.executionIdentity(provider === 'codex' ? config.codexRunUser : config.claudeRunUser)
    if (provider === 'codex') {
      setupOperation = 'Codex login probe'
      await (deps.checkCodexLogin ?? checkCodexLogin)(identity)
    }
  } catch (err) {
    // Cancellation while awaiting setup remains authoritative.
    const status = getTask(task.id)?.status
    if (status === 'failed' || status === 'completed') {
      emitter.emit('event', makeEvent('error', 'Task cancelled before launch'))
      emitter.emit('done')
      removeEmitter(task.id)
      return
    }
    const detail = setupOperation === 'runner identity'
      ? `runner identity failed; check the configured non-root runner account (${launchFailureDetail(err)})`
      : loginFailureDetail(err)
    const message = `[forge] ${provider} setup failed: ${detail}`
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
    deps.gitPull(task.repo, identity)
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

  let proc: ChildProcessWithoutNullStreams
  try {
    const command = providerCommand(provider, task.model)
    proc = deps.spawn(
      command.command,
      provider === 'claude' ? [...command.args, task.prompt] : command.args,
      {
        cwd: task.repo,
        ...identity,
        detached: providerDetached,
      }
    )
  } catch (err) {
    // Spawn errors can include arguments (including the prompt). Persist only
    // known codes and static guidance, never the raw message or thrown value.
    const message = `[forge] failed to launch ${provider}: ${launchFailureDetail(err)}`
    appendLog(task.id, message + '\n')
    setErrorMessage(task.id, message)
    updateTaskStatus(task.id, 'failed')
    emitter.emit('event', makeEvent('error', message))
    emitter.emit('done')
    removeEmitter(task.id)
    return
  }

  let closed: [number | null, NodeJS.Signals | null] | null = null
  let escalationComplete = false
  let settled = false
  // Direct-child exit does not prove descendants have stopped.
  let procExited = false
  let terminationReason: string | null = null
  let spawnError: string | null = null
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null
  let killTimer: ReturnType<typeof setTimeout> | null = null

  // Flush at the pending limit and every 500ms for low-volume output.
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  const formatStderr = stderrLines()
  let buffer = ''
  let flushTimer: ReturnType<typeof setInterval> | null = null

  function flush() {
    if (!buffer) return
    const chunk = buffer
    buffer = ''
    appendLog(task.id, chunk)
    emitter.emit('event', makeEvent('log', chunk))
  }

  function appendOutput(text: string) {
    let offset = 0
    while (offset < text.length) {
      let end = Math.min(text.length, offset + MAX_PENDING_OUTPUT - buffer.length)
      // Keep surrogate pairs together so each SSE chunk is independently valid.
      const last = text.charCodeAt(end - 1)
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
      if (end === offset) {
        flush()
        continue
      }
      buffer += text.slice(offset, end)
      offset = end
      if (buffer.length === MAX_PENDING_OUTPUT) flush()
    }
  }

  function receive(data: Buffer, decoder: StringDecoder, stderr = false) {
    // Bound decoding and stderr prefix expansion even for a huge input chunk.
    for (let offset = 0; offset < data.length; offset += DECODE_INPUT_BYTES) {
      const text = decoder.write(data.subarray(offset, offset + DECODE_INPUT_BYTES))
      appendOutput(stderr ? formatStderr(text) : text)
    }
  }

  flushTimer = setInterval(flush, 500)

  // --- per-task timeout: SIGTERM then SIGKILL a hung agent ---
  // A hung `claude -p` / `codex` child would otherwise run forever, holding a
  // MAX_CONCURRENT_TASKS slot and blocking same-repo serialization until a
  // manual pm2 restart. On timeout we SIGTERM, wait a grace period, then SIGKILL.
  const timeoutMs = config.taskTimeoutMs
  const KILL_GRACE_MS = 10000
  function terminate(reason: string) {
    if (settled || terminationReason) return
    terminationReason = reason
    setErrorMessage(task.id, reason)
    const termMsg = `[forge] ${reason} — sending SIGTERM\n`
    appendLog(task.id, termMsg)
    emitter.emit('event', makeEvent('log', termMsg))
    // Install escalation before SIGTERM; group completion waits for both
    // escalation and close, in either order.
    killTimer = deps.setTimeout(() => {
      if (settled) return
      const msg = '[forge] agent did not exit after SIGTERM — sending SIGKILL\n'
      appendLog(task.id, msg)
      emitter.emit('event', makeEvent('log', msg))
      ;(deps.signalProvider ?? signalProvider)(proc, 'SIGKILL')
      escalationComplete = true
      if (closed) finish(...closed)
    }, KILL_GRACE_MS)
    killTimer.unref?.()
    ;(deps.signalProvider ?? signalProvider)(proc, 'SIGTERM')
  }
  activeProcs.set(task.id, () => terminate(`${provider} task cancelled`))
  timeoutTimer = deps.setTimeout(() => {
    terminate(`${provider} timed out after ${timeoutMs}ms`)
  }, timeoutMs)
  timeoutTimer.unref?.()

  // Exit only describes the direct child; close confirms its stdio is drained.
  proc.on('exit', () => { procExited = true })

  proc.stdout.on('data', (data: Buffer) => {
    receive(data, stdoutDecoder)
  })

  proc.stderr.on('data', (data: Buffer) => {
    receive(data, stderrDecoder, true)
  })

  proc.on('close', (code, signal) => {
    closed = [code, signal]
    procExited = true
    // Descendants may have closed stdio yet still be writing to the checkout.
    if (terminationReason && hasProcessGroup(proc) && !escalationComplete) return
    finish(code, signal)
  })

  function finish(code: number | null, signal: NodeJS.Signals | null) {
    if (settled) return
    settled = true
    if (timeoutTimer) deps.clearTimeout(timeoutTimer)
    if (killTimer) deps.clearTimeout(killTimer)
    appendOutput(stdoutDecoder.end())
    appendOutput(formatStderr(stderrDecoder.end()))
    // Final flush before wrapping up
    if (flushTimer) clearInterval(flushTimer)
    flush()

    activeProcs.delete(task.id)

    if (code === 0 && !terminationReason && spawnError === null) {
      let commitFailed = false
      // Auto-commit if enabled
      if (task.autoCommit ?? config.autoCommit) {
        try {
          const sha = deps.gitCommit(
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
        } catch (err: unknown) {
          commitFailed = true
          const reason = `git commit failed: ${err instanceof Error ? err.message : String(err)}`
          const errMsg = `[forge] ${reason}\n`
          appendLog(task.id, errMsg)
          setErrorMessage(task.id, reason)
          updateTaskStatus(task.id, 'failed')
          emitter.emit('event', makeEvent('error', errMsg))
        }
      }

      if (!commitFailed) {
        updateTaskStatus(task.id, 'completed')
        emitter.emit('event', makeEvent('complete', 'Task completed successfully'))
      }
    } else {
      const reason = terminationReason
        ? `${terminationReason}; ${exitReason(provider, code, signal)}`
        : spawnError !== null
          ? `failed to launch ${provider}: ${spawnError}`
          : exitReason(provider, code, signal)
      const errMsg = `[forge] ${reason}\n`
      appendLog(task.id, errMsg)
      setErrorMessage(task.id, reason)
      updateTaskStatus(task.id, 'failed')
      emitter.emit('event', makeEvent('error', errMsg))
    }


    emitter.emit('done')
    removeEmitter(task.id)
  }

  // Node emits close after error too. An error after launch is not proof of
  // exit (for example a failed kill), so only close releases capacity.
  proc.on('error', (err) => { spawnError = launchFailureDetail(err) })

  // Install the entire lifecycle before writing: end can throw or synchronously
  // report failure, and SIGTERM may immediately close the child in either case.
  function promptDeliveryFailed() {
    // A closed pipe after cancellation/exit is expected. Keep the first reason
    // authoritative and never persist raw errors, which may contain the prompt.
    if (provider !== 'codex' || settled || procExited || terminationReason || spawnError) return
    terminate('codex prompt delivery failed')
  }
  proc.stdin.on('error', promptDeliveryFailed)
  try {
    if (provider === 'codex') {
      proc.stdin.end(task.prompt, (error?: Error | null) => {
        if (error) promptDeliveryFailed()
      })
    } else {
      proc.stdin.end()
    }
  } catch {
    promptDeliveryFailed()
  }
}
