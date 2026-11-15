import type { Verification, RunRequest } from '@forge/shared'
import { command, type Identity } from './process.js'

export interface VerifyInput extends RunRequest { output: string }
export interface Policy { gateTimeoutMs: number; allowWorkflows: boolean; forbiddenPatterns: string[]; requireDraftPR?: boolean; allowNoGate?: boolean; allowTestChanges?: boolean; allowEnvFiles?: boolean; allowSecrets?: boolean }
export async function verifyTask(input: VerifyInput, policy: Policy, identity: Identity = {}): Promise<Verification> {
  const report: Verification = { verified: true, checks: [], diffStats: '', gate: null }
  const check = (name: string, ok: boolean, detail: string, warning = false) => {
    report.checks.push({ name, ok, detail, ...(warning ? { warning } : {}) })
    if (!ok && !warning) report.verified = false
  }
  const git = async (...args: string[]) => {
    const result = await command(input.repo, 'git', args, identity, 30_000, 8_388_608)
    if (result.exit) throw new Error(`git ${args[0]} failed: ${result.tail}`)
    return result.tail.trim()
  }
  check('owner policy', true, JSON.stringify(policy))
  let cmd = input.gate
  let base = input.base ?? 'main'
  const needsPR = policy.requireDraftPR === true
  if (needsPR) {
    try {
      const urls = input.output.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)
      const claims = [...input.output.matchAll(/\bbranch\s*[:=]?\s*[`'"]?([\w./-]+)/gi)]
      const claim = urls?.at(-1) ?? claims.at(-1)?.[1]
      if (!claim) throw new Error('agent output contains no claimed PR URL or branch')
      const result = await command(input.repo, 'gh', ['pr', 'view', claim, '--json', 'state,headRefName,headRefOid,baseRefName,additions,deletions,body,isDraft'], identity, 30_000, 8_388_608)
      if (result.exit) throw new Error(`PR does not exist or could not be read: ${result.tail}`)
      const pr = JSON.parse(result.tail)
      base = input.base ?? pr.baseRefName
      check('PR state', pr.state === 'OPEN' && pr.isDraft === true, 'PR must exist, be open and draft')
      const head = await git('rev-parse', 'HEAD')
      check('PR head', pr.headRefOid === head, 'PR head must match local HEAD')
      const remote = await git('ls-remote', '--exit-code', 'origin', `refs/heads/${pr.headRefName}`)
      check('remote branch', remote.split(/\s/)[0] === head, 'remote branch must exist and match local HEAD')
    } catch (err) { check('PR state', false, (err as Error).message) }
  } else check('PR state', true, 'PR verification skipped for this request')
  try {
    if (!base || !/^[\w./-]+$/.test(base) || base.startsWith('-')) throw new Error('invalid base branch')
    await git('fetch', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`)
    if (!cmd) {
      const trusted = await command(input.repo, 'git', ['show', `origin/${base}:.forge/gate`], identity, 30_000)
      if (trusted.exit === 0) cmd = trusted.tail.trim()
    }
    if (cmd) {
      const result = await command(input.repo, '/bin/bash', ['-c', cmd], identity, policy.gateTimeoutMs)
      report.gate = { cmd, ...result }
      check('gate', result.exit === 0, `behavioral gate exited ${result.exit}`)
    } else check('gate', policy.allowNoGate === true, 'No behavioral gate selected; owner must explicitly allow no gate')
    const dirty = await git('status', '--porcelain=v1', '--untracked-files=all')
    check('working tree', dirty.length === 0, 'working tree must be clean, including untracked files, so verification covers the final repository state')
    const range = `origin/${base}...HEAD`
    report.diffStats = await git('diff', '--stat', range)
    const files = (await git('diff', '--name-only', '--no-renames', range)).split('\n').filter(Boolean)
    for (const file of files) {
      const diff = await git('diff', '--no-ext-diff', '--no-renames', '--unified=0', range, '--', file)
      const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1))
      const removed = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.slice(1))
      const justified = policy.allowTestChanges === true
      const isTest = /(^|\/)(__tests__|tests?)\/|([._-](test|spec)\.[^/]+$)|(^|\/)test_[^/]+\.py$|(^|\/)(tests?|spec)\.[^/]+$/.test(file)
      if (isTest) {
        if (/deleted file mode/.test(diff)) check('deleted test', justified, `${file}: deleted test file requires owner allowance`)
        if (removed.some(l => /\b(it|test)\s*\(|\bdef test_/.test(l))) check('removed test case', justified, `${file}: removed test cases require owner allowance`)
        if (added.some(l => /\.(skip|only)\b|\bx(it|test)\s*\(|@pytest\.mark\.(skip|xfail)/.test(l))) check('test skip', justified, `${file}: new skip or only requires owner allowance`)
        if (removed.some(l => /\b(assert|expect)\b/.test(l)) && !added.some(l => /\b(assert|expect)\b/.test(l))) check('removed assertions', justified, `${file}: removed assertions require owner allowance`)
      }
      check('env files', policy.allowEnvFiles === true || /deleted file mode/.test(diff) || !/(^|\/)\.env(?:\.|$)/.test(file), `${file}: committed .env file is forbidden`)
      if (!policy.allowWorkflows) check('workflow edits', !file.startsWith('.github/workflows/'), `${file}: workflow edits require owner permission`)
      const secrets = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|(?:api[_-]?key|token|secret)\s*[:=]\s*["'][A-Za-z0-9_/-]{20,}["']/i
      check('secrets', policy.allowSecrets === true || !added.some(l => secrets.test(l)), `${file}: added content contains a possible secret`)
      for (const pattern of policy.forbiddenPatterns) check('deny pattern', !new RegExp(pattern).test(added.join('\n')), `${file}: forbidden diff pattern ${pattern}`)
      if (/(^|\/)package\.json$/.test(file)) {
        const before = await command(input.repo, 'git', ['show', `origin/${base}:${file}`], identity, 30_000, 8_388_608)
        const after = JSON.parse(await git('show', `HEAD:${file}`))
        const old = before.exit ? {} : JSON.parse(before.tail)
        const deps = (p: any) => ({ ...p.dependencies, ...p.devDependencies, ...p.optionalDependencies })
        const addedDeps = Object.keys(deps(after)).filter(d => !(d in deps(old)) && !input.allowedDependencies?.includes(d))
        check('dependencies', addedDeps.length === 0, `${file}: new dependencies outside allowlist: ${addedDeps.join(', ')}`, true)
      }
    }
  } catch (err) { check('diff inspection', false, (err as Error).message) }
  report.verdict = report.verified ? 'verified' : 'unverified'
  return report
}
