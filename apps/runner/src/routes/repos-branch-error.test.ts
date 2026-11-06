import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverRepos } from './repos.js'

for (const branchFails of [false, true]) {
  for (const statusFails of [false, true]) {
    test(`branch failure=${branchFails}, status failure=${statusFails} remain independent`, t => {
      const root = mkdtempSync(join(tmpdir(), 'forge-branch-error-'))
      t.after(() => rmSync(root, { recursive: true, force: true }))
      const subject = join(root, 'subject')
      const sibling = join(root, 'sibling')
      for (const path of [subject, sibling]) mkdirSync(join(path, '.git'), { recursive: true })
      const branchReads: string[] = []
      const statusReads: string[] = []
      const repos = discoverRepos([root], {
        getCurrentBranch: path => {
          branchReads.push(path)
          if (path === subject && branchFails) throw new Error('private branch stderr')
          return path === subject ? 'unknown' : 'healthy'
        },
        hasUncommittedChanges: path => {
          statusReads.push(path)
          if (path === subject && statusFails) throw new Error('private status stderr')
          return false
        },
      })
      assert.deepEqual(repos, [
        { name: 'sibling', path: sibling, currentBranch: 'healthy', dirty: false },
        { name: 'subject', path: subject, currentBranch: 'unknown', dirty: statusFails,
          ...(branchFails ? { branchError: 'unavailable' } : {}),
          ...(statusFails ? { statusError: 'unavailable' } : {}) },
      ])
      assert.deepEqual(branchReads.sort(), [sibling, subject])
      assert.deepEqual(statusReads.sort(), [sibling, subject])
      assert.equal(JSON.stringify(repos).includes('private'), false)
    })
  }
}
