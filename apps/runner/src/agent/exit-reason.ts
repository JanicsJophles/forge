// Human-readable reason for a non-zero/failed child exit. A killed child
// (DELETE /tasks/:id SIGTERM, timeout SIGKILL, or the OS) exits with code=null
// and signal set — report the signal instead of a meaningless
// "exited with code null" so a triaging dispatcher sees why it stopped.
export function exitReason(
  provider: string,
  code: number | null,
  signal: NodeJS.Signals | null
): string {
  if (code === null && signal) return `${provider} terminated by ${signal}`
  return `${provider} exited with code ${code}`
}
