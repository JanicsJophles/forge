export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed'
export type AgentProvider = 'claude' | 'codex'

export interface AgentTask {
  provider?: AgentProvider
  autoCommit?: boolean
  // When true the runner enforces read-only execution: the agent cannot edit,
  // write, run mutating bash, commit, or push, and any working-tree change is
  // reverted and the task failed. Defaults to false (unchanged behavior).
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
