export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed'
export type AgentProvider = 'claude' | 'codex'
/** An engine a task may move to when its current engine runs out of usage, with any extra brief for it. */
export interface FallbackProvider {
  provider: AgentProvider
  promptNote?: string
}

export interface AgentTask {
  provider?: AgentProvider
  /** In memory only: engines to continue on if this one hits its usage limit. */
  fallbackProviders?: FallbackProvider[]
  autoCommit?: boolean
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
  fallbackProviders?: FallbackProvider[]
  repo: string          // absolute path on the LXC / local machine
  branch?: string
  prompt: string
  autoCommit?: boolean
}
