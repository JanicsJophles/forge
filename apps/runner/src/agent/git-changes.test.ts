import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  summarizeChangedFiles,
  boundChangedFiles,
  CHANGED_FILES_LIMIT,
  type ChangedFile,
} from './git-changes.js'

test('summarizeChangedFiles counts a mixed M/A/D/R/C/untracked set by status letter', () => {
  const files: ChangedFile[] = [
    { path: 'a.txt', status: 'M' },
    { path: 'b.txt', status: 'M' },
    { path: 'c.txt', status: 'A' },
    { path: 'd.txt', status: 'D' },
    { path: 'e.txt', status: 'R100' }, // rename collapses to renamed
    { path: 'f.txt', status: 'C75' }, // copy collapses to copied
    { path: 'g.txt', status: '?' },
    { path: 'h.txt', status: '?' },
  ]

  const summary = summarizeChangedFiles(files)
  assert.deepEqual(summary, {
    added: 1,
    modified: 2,
    deleted: 1,
    renamed: 1,
    copied: 1,
    untracked: 2,
    total: 8,
  })
})

test('summarizeChangedFiles counts unknown status letters only in total', () => {
  const files: ChangedFile[] = [
    { path: 'u.txt', status: 'U' }, // unmerged — no named bucket
    { path: 'x.txt', status: 'M' },
  ]

  const summary = summarizeChangedFiles(files)
  assert.equal(summary.total, 2)
  assert.equal(summary.modified, 1)
  assert.equal(
    summary.added + summary.deleted + summary.renamed + summary.copied + summary.untracked,
    0,
  )
})

test('boundChangedFiles leaves a within-bounds list untouched', () => {
  const files: ChangedFile[] = [
    { path: 'a.txt', status: 'M' },
    { path: 'b.txt', status: 'A' },
  ]

  const bounded = boundChangedFiles(files)
  assert.equal(bounded.truncated, false)
  assert.equal(bounded.changedFiles.length, 2)
  assert.deepEqual(bounded.changedFiles, files)
})

test('boundChangedFiles caps the list and flags truncation while summary totals stay complete', () => {
  const overflow = CHANGED_FILES_LIMIT + 123
  const files: ChangedFile[] = Array.from({ length: overflow }, (_, i) => ({
    path: `untracked-${i}.txt`,
    status: '?',
  }))

  // The summary reflects the FULL set even though the list will be capped.
  const summary = summarizeChangedFiles(files)
  assert.equal(summary.total, overflow)
  assert.equal(summary.untracked, overflow)

  const bounded = boundChangedFiles(files)
  assert.equal(bounded.truncated, true)
  assert.equal(bounded.changedFiles.length, CHANGED_FILES_LIMIT)
})
