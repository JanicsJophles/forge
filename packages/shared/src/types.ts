export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed'
export type AgentProvider = 'claude' | 'codex'

export interface AgentTask {
  provider?: AgentProvider
  autoCommit?: boolean
  // When true the runner runs the task against a disposable copy of the repo
  // (clone of committed history + overlay of uncommitted, non-ignored files),
  // as a separate credential-less account with all remotes removed, so the real
  // repo is never written to. Requires READONLY_RUN_USER to be configured;
  // otherwise the request is refused. Defaults to false (unchanged behavior).
  readOnly?: boolean
  id: string
  repo: string
  branch: string
  prompt: string
  status: TaskStatus
  log: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  errorMessage?: string
  commitSha?: string
}

export interface TaskEvent {
  type: 'log' | 'status' | 'complete' | 'error'
  data: string
  timestamp: string
}

export interface RunRequest {
  provider?: AgentProvider
  repo: string          // absolute path on the LXC / local machine
  branch?: string
  prompt: string
  autoCommit?: boolean
  readOnly?: boolean
}
