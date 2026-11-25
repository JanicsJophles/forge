// Claude runs with `--output-format stream-json --verbose`: one JSON event per stdout line. The task log gets one
// short human line per event instead (tool name and its first argument, a result marker, the final answer), so a
// running task shows live progress and the database never stores raw event JSON.

/** Longest stdout line that is parsed; longer ones (huge tool results) are skipped up to their newline. */
export const MAX_EVENT_LINE = 2 * 1024 * 1024
const ARG_CHARS = 120
const TEXT_CHARS = 200
const RESULT_CHARS = 20_000

export interface ClaudeOutcome {
  /** The final `result` event's text, capped. */
  text?: string
  isError?: boolean
  /** From a `PR: <url>` line in the final text. */
  prUrl?: string
  /** From an `ABORTED: <reason>` line in the final text. */
  aborted?: string
}

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// The argument that says what a tool call is about, in the order tools name it.
const ARG_KEYS = ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'description', 'prompt', 'skill']

export function firstArgument(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of ARG_KEYS) if (typeof record[key] === 'string' && record[key]) return oneLine(record[key] as string, ARG_CHARS)
  for (const value of Object.values(record)) if (typeof value === 'string' && value) return oneLine(value, ARG_CHARS)
  return ''
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '')).join(' ')
  }
  return ''
}

export function parseOutcome(text: string, isError: boolean): ClaudeOutcome {
  const outcome: ClaudeOutcome = { text: text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n…` : text, isError }
  const pr = /^\s*PR:\s*(https:\/\/\S+)/m.exec(text)
  if (pr) outcome.prUrl = pr[1]
  const aborted = /^\s*ABORTED:\s*(.*)$/m.exec(text)
  if (aborted) outcome.aborted = oneLine(aborted[1], 500)
  return outcome
}

/** The log lines for one event (usually one, none for bookkeeping events). */
export function describeEvent(event: any, onOutcome?: (outcome: ClaudeOutcome) => void): string[] {
  if (!event || typeof event !== 'object') return []
  switch (event.type) {
    case 'system':
      return event.subtype === 'init' ? [`[claude] session started${event.model ? ` (${oneLine(String(event.model), 60)})` : ''}`] : []
    case 'assistant': {
      const lines: string[] = []
      for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (part?.type === 'tool_use') {
          const arg = firstArgument(part.input)
          lines.push(`[tool] ${oneLine(String(part.name ?? 'tool'), 60)}${arg ? `: ${arg}` : ''}`)
        } else if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          lines.push(`[claude] ${oneLine(part.text, TEXT_CHARS)}`)
        }
      }
      return lines
    }
    case 'user': {
      const lines: string[] = []
      for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (part?.type !== 'tool_result') continue
        lines.push(part.is_error ? `  -> error: ${oneLine(resultText(part.content), ARG_CHARS)}` : '  -> ok')
      }
      return lines
    }
    case 'rate_limit_event': {
      const status = event.rate_limit_info?.status
      return status && status !== 'allowed' ? [`[claude] rate limit: ${oneLine(String(status), 40)}`] : []
    }
    case 'result': {
      const text = typeof event.result === 'string' ? event.result : ''
      const isError = event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success')
      const outcome = parseOutcome(text, isError)
      onOutcome?.(outcome)
      const turns = Number.isInteger(event.num_turns) ? `, ${event.num_turns} turns` : ''
      const secs = typeof event.duration_ms === 'number' ? `, ${(event.duration_ms / 1000).toFixed(1)}s` : ''
      const lines = [`[claude] finished: ${oneLine(String(event.subtype ?? 'done'), 40)}${turns}${secs}`]
      if (outcome.text) lines.push(outcome.text.replace(/\n+$/, ''))
      return lines
    }
    default:
      return []
  }
}

/** Splits stdout into lines across chunks and turns each into log lines. */
export class ClaudeStreamParser {
  private partial = ''
  private skipping = 0
  outcome: ClaudeOutcome | undefined

  constructor(private readonly maxLine = MAX_EVENT_LINE) {}

  /** Feed a decoded stdout chunk; returns the log text it produced (whole lines, each ending in \n). */
  push(chunk: string): string {
    let out = ''
    let start = 0
    for (let nl = chunk.indexOf('\n'); nl !== -1; nl = chunk.indexOf('\n', start)) {
      out += this.take(chunk.slice(start, nl), true)
      start = nl + 1
    }
    out += this.take(chunk.slice(start), false)
    return out
  }

  /** The process ended: a last line without a newline still counts. */
  end(): string {
    return this.take('', true)
  }

  private take(piece: string, complete: boolean): string {
    if (this.skipping) {
      this.skipping += piece.length
      if (!complete) return ''
      const size = this.skipping
      this.skipping = 0
      return `[forge] skipped an oversized output line (${size} characters)\n`
    }
    if (this.partial.length + piece.length > this.maxLine) {
      this.skipping = this.partial.length + piece.length
      this.partial = ''
      return complete ? this.take('', true) : ''
    }
    this.partial += piece
    if (!complete) return ''
    const line = this.partial.trim()
    this.partial = ''
    if (!line) return ''
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      // Not an event (a CLI warning, or plain text from an older CLI): keep it, shortened.
      return `${oneLine(line, 2000)}\n`
    }
    return describeEvent(event, outcome => { this.outcome = outcome }).map(l => `${l}\n`).join('')
  }
}
