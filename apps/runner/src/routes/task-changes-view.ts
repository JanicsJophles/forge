import { Router } from 'express'
import { db } from '../db/schema.js'
import { getChangesPatch, getChangedFiles, summarizeChangedFiles, boundChangedFiles } from '../agent/git-changes.js'

export const taskChangesViewRouter = Router()

const FAILURE_REASON_CHAR_CAP = 2000

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Decode Git's C-quoted byte strings without treating filenames as markup or IDs.
function gitPath(value: string): string | null {
  if (!value.startsWith('"')) return value.includes('"') ? null : value
  if (!value.endsWith('"')) return null
  const bytes: number[] = []
  const escapes: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' }
  for (let i = 1; i < value.length - 1; i++) {
    const char = value[i]
    if (char === '"') return null
    if (char !== '\\') {
      const point = value.codePointAt(i)!
      bytes.push(...Buffer.from(String.fromCodePoint(point)))
      if (point > 0xffff) i++
      continue
    }
    const rest = value.slice(i + 1, -1)
    const octal = /^[0-3][0-7]{2}/.exec(rest)
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue }
    const escaped = escapes[value[++i]]
    if (escaped === undefined) return null
    bytes.push(...Buffer.from(escaped))
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)) } catch { return null }
}

/** Only complete, unambiguous headers in the rendered patch can be targets. */
export function patchNavigation(patch: string): { targets: Map<string, string>; anchors: Map<number, string> } {
  const targets = new Map<string, string>()
  const anchors = new Map<number, string>()
  const seen = new Set<string>()
  const lines = patch.split('\n')
  lines.forEach((line, index) => {
    if (index === lines.length - 1 || !line.startsWith('diff --git ')) return
    const header = line.slice(11)
    const candidates: string[] = []
    for (let split = header.indexOf(' '); split !== -1; split = header.indexOf(' ', split + 1)) {
      const before = gitPath(header.slice(0, split))
      const after = gitPath(header.slice(split + 1))
      if (before?.startsWith('a/') && after?.startsWith('b/')) candidates.push(after.slice(2))
    }
    if (candidates.length !== 1) return
    const path = candidates[0]
    const id = `patch-section-${index}`
    anchors.set(index, id)
    if (seen.has(path)) targets.delete(path)
    else targets.set(path, id)
    seen.add(path)
  })
  return { targets, anchors }
}

// Keep error output independent of Git diagnostics and partially captured patches.
function errorPage(taskId: string, unavailable: boolean): string {
  const id = escapeHtml(taskId)
  const retryHref = escapeHtml(`/tasks/${encodeURIComponent(taskId)}/changes/view`)
  const title = unavailable ? 'Changes temporarily unavailable' : 'Task not found'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>forge · ${title}</title>
  <style>
    body { margin: 20px; background: #030712; color: #e4e4e7; font: 14px system-ui, sans-serif; overflow-wrap: anywhere; }
    a { color: #34d399; margin-right: 16px; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>Task: <code>${id}</code></p>
    <p>${unavailable
      ? 'Could not inspect repository changes. Try again when the checkout is available.'
      : 'This task could not be found. It may have been pruned from retained history.'}</p>
    <nav aria-label="Review navigation">
      ${unavailable ? `<a href="${retryHref}">Retry changes</a>` : ''}
      <a href="/history">task history</a><a href="/dashboard">dashboard</a>
    </nav>
  </main>
</body>
</html>`
}

taskChangesViewRouter.get('/:id/changes/view', (req, res) => {
  // Bound diagnostics in SQLite; never load the stored log or prompt for review.
  const task = db.prepare(`SELECT repo, commit_sha, status,
    substr(error_message, 1, ${FAILURE_REASON_CHAR_CAP}) AS failure_reason,
    length(error_message) > ${FAILURE_REASON_CHAR_CAP} AS failure_truncated
    FROM tasks WHERE id = ?`).get(req.params.id) as
    { repo: string; commit_sha: string | null; status: string | null;
      failure_reason: string | null; failure_truncated: number | null } | undefined
  if (!task) {
    res.status(404).type('html').send(errorPage(req.params.id, false))
    return
  }
  let result
  let files
  try {
    result = getChangesPatch(task.repo, task.commit_sha)
    files = getChangedFiles(task.repo, task.commit_sha)
  } catch {
    res.status(503).type('html').send(errorPage(req.params.id, true))
    return
  }
  const summary = summarizeChangedFiles(files)
  const bounded = boundChangedFiles(files)
  const navigation = patchNavigation(result.patch)
  const fileList = bounded.changedFiles.map(file => {
    const target = file.status === '?' ? undefined : navigation.targets.get(file.path)
    const name = `<code>${escapeHtml(file.path)}</code>`
    return `<li><code>${escapeHtml(file.status)}</code> ${target
      ? `<a href="#${target}">${name}</a>`
      : `${name} <small>(no identified patch section)</small>`}</li>`
  }).join('\n')
  const lines = result.patch.split('\n').map((line, index) => {
    const kind = line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')
      ? 'file' : line.startsWith('@@') ? 'hunk'
        : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context'
    const anchor = navigation.anchors.get(index)
    return `<span${anchor ? ` id="${anchor}" tabindex="-1"` : ''} class="${kind}">${escapeHtml(line)}</span>`
  }).join('\n')
  const id = escapeHtml(req.params.id)
  const refreshHref = escapeHtml(`/tasks/${encodeURIComponent(req.params.id)}/changes/view`)
  const active = task.status === 'queued' || task.status === 'running'
  const rawHref = escapeHtml(`/tasks/${encodeURIComponent(req.params.id)}/changes?format=patch`)
  res.setHeader('X-Patch-Truncated', String(result.truncated))
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>forge · changes ${id}</title>
  <style>
    body { margin: 0; background: #030712; color: #e4e4e7; font: 14px system-ui, sans-serif; }
    header, main { padding: 16px 20px; }
    h1 { font-size: 18px; }
    a { color: #34d399; margin-right: 16px; }
    pre { overflow: auto; padding: 12px; background: #0a0f1e; line-height: 1.5; }
    pre span { display: inline-block; min-width: 100%; }
    #wrap-lines:checked ~ pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    #wrap-lines:checked ~ pre span { width: 100%; }
    .added { color: #86efac; background: #052e16; }
    .removed { color: #fca5a5; background: #450a0a; }
    .file { color: #93c5fd; font-weight: bold; }
    pre span:target { outline: 2px solid #34d399; }
    .hunk { color: #c4b5fd; }
    li code { white-space: pre-wrap; overflow-wrap: anywhere; }
    .failure-reason { white-space: pre-wrap; overflow-wrap: anywhere; }
    .warning { color: #fbbf24; }
  </style>
</head>
<body>
  <header><h1>forge changes · ${id}</h1>
    <p>Repository: ${escapeHtml(task.repo)}</p>
    <a href="${rawHref}">raw patch</a><a href="/dashboard">dashboard</a>
  </header>
  <main>
    <section aria-label="Task outcome">
      <h2>Task outcome</h2>
      <p>Recorded task status: <strong>${escapeHtml(task.status || 'unavailable')}</strong></p>
      ${task.status === 'failed'
        ? task.failure_reason
          ? `<p class="failure-reason">Saved failure reason: ${escapeHtml(task.failure_reason)}</p>${task.failure_truncated ? `<p class="warning">Failure reason truncated: showing the first ${FAILURE_REASON_CHAR_CAP} characters.</p>` : ''}`
          : '<p>No saved failure reason is available.</p>'
        : ''}
      ${active ? `<p>Task is active. ${task.commit_sha == null ? 'The displayed checkout diff is a snapshot and may change.' : 'The displayed diff is from the recorded commit; task metadata may change.'} <a href="${refreshHref}">Refresh this task review</a></p>` : ''}
    </section>
    ${task.commit_sha != null
      ? `<p>Recorded commit changes: <code>${escapeHtml(task.commit_sha)}</code></p>`
      : '<p>Current tracked changes in the task checkout. Untracked file contents are not included.</p>'}
    <section aria-label="Changed files">
      <h2>Changed files</h2>
      <p>${summary.total} changed files: ${summary.added} added, ${summary.modified} modified, ${summary.deleted} deleted, ${summary.renamed} renamed, ${summary.copied} copied, ${summary.untracked} untracked.</p>
      ${summary.total ? `<ul>${fileList}</ul>` : '<p>No changed files.</p>'}
      ${bounded.truncated ? `<p class="warning" role="status">File list truncated: showing ${bounded.changedFiles.length} of ${summary.total} changed files. Counts include all changed files.</p>` : ''}
    </section>
    ${result.truncated ? '<p class="warning" role="status">Patch truncated: only the first part is shown.</p>' : ''}
    ${result.patch ? `<input type="checkbox" id="wrap-lines" aria-controls="unified-diff" />
    <label for="wrap-lines">Wrap lines</label>
    <pre id="unified-diff" aria-label="Unified diff">${lines}</pre>` : '<p>No tracked changes. No tracked patch to display; untracked file contents are not included.</p>'}
  </main>
</body>
</html>`)
})
