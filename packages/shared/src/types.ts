export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface AgentTask {
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
  repo: string          // absolute path on the LXC / local machine
  branch?: string
  prompt: string
  autoCommit?: boolean
}
