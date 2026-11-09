export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed'
export type AgentProvider = 'claude' | 'codex'

export interface AgentTask {
  provider?: AgentProvider
  autoCommit?: boolean
  /** Optional provider model override; passed as `--model`/`-m` when set. */
  model?: string
  id: string
  repo: string
  branch: string
  prompt: string
  status: TaskStatus
  log: string
  /** Full byte length of the log column (set on list views where `log` is a tail). */
  logBytes?: number
  /** True when `log` is a truncated tail of a larger transcript (list views). */
  logTruncated?: boolean
  /** Full byte length of the prompt column (set on list views where `prompt` is a bounded head). */
  promptBytes?: number
  /** True when `prompt` is a truncated head of a larger prompt (list views). */
  promptTruncated?: boolean
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
  /** Optional provider model override (validated server-side before dispatch). */
  model?: string
}
