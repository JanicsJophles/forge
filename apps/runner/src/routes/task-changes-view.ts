import { Router } from 'express'
import { db } from '../db/schema.js'
import { getChangesPatch, getChangedFiles, summarizeChangedFiles, boundChangedFiles } from '../agent/git-changes.js'

export const taskChangesViewRouter = Router()

const FAILURE_REASON_CHAR_CAP = 2000

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
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
    res.status(404).json({ error: 'task not found' })
    return
  }
  let result
  let files
  try {
    result = getChangesPatch(task.repo, task.commit_sha)
    files = getChangedFiles(task.repo, task.commit_sha)
  } catch {
    res.status(503).json({ error: 'could not inspect repository changes' })
    return
  }
  const summary = summarizeChangedFiles(files)
  const bounded = boundChangedFiles(files)
  const fileList = bounded.changedFiles.map(file =>
    `<li><code>${escapeHtml(file.status)}</code> <code>${escapeHtml(file.path)}</code></li>`,
  ).join('\n')
  const lines = result.patch.split('\n').map(line => {
    const kind = line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')
      ? 'file' : line.startsWith('@@') ? 'hunk'
        : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context'
    return `<span class="${kind}">${escapeHtml(line)}</span>`
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
    .added { color: #86efac; background: #052e16; }
    .removed { color: #fca5a5; background: #450a0a; }
    .file { color: #93c5fd; font-weight: bold; }
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
    ${result.patch ? `<pre aria-label="Unified diff">${lines}</pre>` : '<p>No tracked changes. No tracked patch to display; untracked file contents are not included.</p>'}
  </main>
</body>
</html>`)
})
