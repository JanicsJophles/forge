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
  failureKind?: 'unverified' | 'capped'
  errorMessage?: string
  options?: RunRequest
  verification?: Verification
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
  verify?: boolean
  gate?: string
  base?: string
  maxWallMinutes?: number
  maxOutputBytes?: number
  allowedDependencies?: string[]
  autoCommit?: boolean
}

export interface Verification {
  verdict?: 'verified' | 'unverified' | 'capped'
  verified: boolean
  checks: { name: string; ok: boolean; detail: string; warning?: boolean }[]
  diffStats: string
  gate: { cmd: string; exit: number; tail: string } | null
}
