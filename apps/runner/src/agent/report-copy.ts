// Post-run report worker (finding B).
//
// Summarising what the agent changed inside the disposable copy means running
// `git status` / `git log` IN the copy — a tree the agent fully controls. Doing that
// synchronously with execFileSync inside the runner's `close` handler (the old design)
// blocked the event loop: a planted `filter.<n>.process = sleep infinity` wedged the
// whole runner for the git call's duration. So the report runs HERE, in a throwaway
// child process that has already dropped to the read-only account with a minimal env,
// and the parent enforces a hard timeout + whole-tree kill. git itself is additionally
// hardened (filters/hooks/fsmonitor/external-diff/textconv/gpg all neutralised) so no
// copy-local config can execute code even within this child.
//
// Contract: argv = [copyRepo, baseHead]. Prints the report text to stdout, exits 0.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { reportReadOnlyChanges } from './readonly.js'

function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  const [copyRepo, baseHead] = process.argv.slice(2)
  if (!copyRepo || !baseHead) {
    process.stderr.write('usage: report-copy <copyRepo> <baseHead>\n')
    process.exit(2)
  }
  try {
    process.stdout.write(reportReadOnlyChanges(copyRepo, baseHead))
    process.exit(0)
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n')
    process.exit(1)
  }
}
