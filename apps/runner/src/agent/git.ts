import { execSync } from 'node:child_process'

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8' }).trim()
}

export function getCurrentBranch(repoPath: string): string {
  return exec('git rev-parse --abbrev-ref HEAD', repoPath)
}

export function gitPull(repoPath: string): void {
  // If there is no upstream configured (e.g. fresh local repo), pulling
  // is a no-op rather than a hard failure. We detect this by checking
  // whether there is a remote tracking branch before attempting.
  try {
    const upstream = execSync('git rev-parse --abbrev-ref --symbolic-full-name @{u}', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (upstream) {
      exec('git pull --ff-only', repoPath)
    }
  } catch {
    // No upstream configured — skip pull silently
  }
}

export function gitCommit(repoPath: string, message: string): string {
  // Stage all tracked modifications (but not untracked files — let the
  // agent's own git add handle staging if it chose to add new files)
  try {
    exec('git add -u', repoPath)
  } catch {
    // Nothing tracked was modified — that's fine
  }

  try {
    exec(`git commit -m ${JSON.stringify(message)}`, repoPath)
  } catch (err: any) {
    // "nothing to commit" is not a real error
    if (err.stdout?.includes('nothing to commit') || err.stderr?.includes('nothing to commit')) {
      return ''
    }
    throw err
  }

  return exec('git rev-parse HEAD', repoPath)
}

export function hasUncommittedChanges(repoPath: string): boolean {
  const output = exec('git status --porcelain', repoPath)
  return output.length > 0
}
