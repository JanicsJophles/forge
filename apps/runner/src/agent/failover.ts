import type { AgentProvider, FallbackProvider } from '@forge/shared'

/**
 * Usage-limit notices from the agent CLIs, e.g.
 *   Claude Code  "Claude AI usage limit reached|1764000000", "5-hour limit reached ∙ resets 10am (America/Chicago)"
 *   Codex CLI    "You've hit your usage limit. ... try again at Dec 1st, 2026 12:00 AM."
 * Brain's gateway parses the same shapes (backend/gateway/src/providers/limits.ts) to learn reset times.
 */
const LIMIT = /(Claude AI usage limit reached|usage limit reached|usage_limit_reached|hit your (?:[\w-]+ )?limit|(?:5-hour|five-hour|session|weekly|daily|Opus|Sonnet) limit reached)/i
/** Only the end of a run says why it stopped; earlier output may be the task itself discussing limits. */
const TAIL = 1200
/** A clean exit whose whole output is this short and names a limit did no work. */
const SHORT_RUN = 600

/** The limit line at the end of a run's output, or null when the run did not stop on a usage limit. */
export function usageLimitLine(output: string, exitCode: number | null): string | null {
  const agentOutput = output.split('\n').filter(line => !line.startsWith('[forge] ')).join('\n').trim()
  if (exitCode === 0 && agentOutput.length > SHORT_RUN) return null
  const tail = agentOutput.slice(-TAIL)
  const line = tail.split('\n').reverse().find(l => LIMIT.test(l))
  return line ? line.replace(/^\[stderr\]\s*/, '').trim().slice(0, 300) : null
}

export function validFallbacks(value: unknown): FallbackProvider[] | undefined | 'invalid' {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 2) return 'invalid'
  const seen = new Set<AgentProvider>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return 'invalid'
    const { provider, promptNote } = entry as FallbackProvider
    if ((provider !== 'claude' && provider !== 'codex') || seen.has(provider)) return 'invalid'
    if (promptNote !== undefined && (typeof promptNote !== 'string' || promptNote.length > 2000)) return 'invalid'
    seen.add(provider)
  }
  return value as FallbackProvider[]
}

/** The prompt for the engine that continues a task the previous engine could not finish. */
export function continuedPrompt(prompt: string, from: AgentProvider, next: FallbackProvider, limitLine: string): string {
  const name = (p: AgentProvider) => p === 'claude' ? 'Claude Code' : 'Codex'
  const note = `[Atlas failover] ${name(from)} stopped because it ran out of usage ("${limitLine}"). You are continuing on ${name(next.provider)}. `
    + 'The checkout may already hold partial work: read git status and the branch first, then continue instead of starting over.'
  return `${prompt}\n\n${note}${next.promptNote ? `\n\n[Atlas engine note] ${next.promptNote}` : ''}`
}
