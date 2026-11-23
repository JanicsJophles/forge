import type { AgentProvider } from '@forge/shared'
import { config } from './config.js'
import { executionIdentity, type ExecutionIdentity } from './agent/provider.js'

export interface RunnerCapabilities {
  providerSelectionVersion: number
  providers: AgentProvider[]
  readOnly: boolean
}

// Resolve a read-only account by name, or null if it is unusable: no name given,
// the account does not exist, or it resolves to root (executionIdentity throws on
// uid 0). Resolved per-call (getent) so an operator can create the account without
// restarting the runner.
export function readOnlyIdentityFor(username: string | undefined): ExecutionIdentity | null {
  if (!username) return null
  try {
    return executionIdentity(username)
  } catch {
    return null
  }
}

// Resolve the configured read-only account (READONLY_RUN_USER), or null.
export function resolveReadOnlyIdentity(): ExecutionIdentity | null {
  return readOnlyIdentityFor(config.readonlyRunUser)
}

// Advertised by GET /tasks/capabilities so the caller enables the read-only option
// only for runners that actually enforce it. `readOnly` is true ONLY when a usable,
// isolated read-only account is configured — never a bare claim.
export function getCapabilities(): RunnerCapabilities {
  return {
    providerSelectionVersion: 1,
    providers: ['claude', 'codex'],
    readOnly: resolveReadOnlyIdentity() !== null,
  }
}
