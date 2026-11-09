import { Router } from 'express'
import { db } from '../db/schema.js'
import { getChangesPatch } from '../agent/git-changes.js'

export const taskChangesViewRouter = Router()

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

taskChangesViewRouter.get('/:id/changes/view', (req, res) => {
  // Avoid loading the task's potentially large log just to locate its checkout.
  const task = db.prepare('SELECT repo, commit_sha FROM tasks WHERE id = ?').get(req.params.id) as
    { repo: string; commit_sha: string | null } | undefined
  if (!task) {
    res.status(404).json({ error: 'task not found' })
    return
  }
  let result
  try {
    result = getChangesPatch(task.repo, task.commit_sha)
  } catch {
    res.status(503).json({ error: 'could not inspect repository changes' })
    return
  }
  const lines = result.patch.split('\n').map(line => {
    const kind = line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')
      ? 'file' : line.startsWith('@@') ? 'hunk'
        : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context'
    return `<span class="${kind}">${escapeHtml(line)}</span>`
  }).join('\n')
  const id = escapeHtml(req.params.id)
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
    .warning { color: #fbbf24; }
  </style>
</head>
<body>
  <header><h1>forge changes · ${id}</h1>
    <p>Repository: ${escapeHtml(task.repo)}</p>
    <a href="${rawHref}">raw patch</a><a href="/dashboard">dashboard</a>
  </header>
  <main>
    ${task.commit_sha != null
      ? `<p>Recorded commit changes: <code>${escapeHtml(task.commit_sha)}</code></p>`
      : '<p>Current tracked changes in the task checkout. Untracked file contents are not included.</p>'}
    ${result.truncated ? '<p class="warning" role="status">Patch truncated: only the first part is shown.</p>' : ''}
    ${result.patch ? `<pre aria-label="Unified diff">${lines}</pre>` : '<p>No tracked changes.</p>'}
  </main>
</body>
</html>`)
})
