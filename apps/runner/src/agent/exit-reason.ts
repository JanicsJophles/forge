// Human-readable reason for a non-zero/failed child exit. A killed child
// (DELETE /tasks/:id SIGTERM, timeout SIGKILL, or the OS) exits with code=null
// and signal set — report the signal instead of a meaningless
// "exited with code null" so a triaging dispatcher sees why it stopped.
//
// A short static parenthetical is appended for the common cases so the
// errorMessage is self-explaining to a triaging operator. The hint text is
// entirely static (no interpolation of child output, paths, or env) so it is
// always safe to persist and return.
export function exitReason(
  provider: string,
  code: number | null,
  signal: NodeJS.Signals | null
): string {
  if (code === null && signal) {
    const base = `${provider} terminated by ${signal}`
    if (signal === 'SIGTERM') return `${base} (cancelled or shutting down)`
    if (signal === 'SIGKILL') return `${base} (timed out or force-killed)`
    return base
  }
  const base = `${provider} exited with code ${code}`
  if (typeof code === 'number') return `${base} (agent reported an error — see the task log)`
  return base
}
