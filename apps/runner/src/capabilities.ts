import type { AgentProvider } from '@forge/shared'
import { config } from './config.js'
import { executionIdentity, type ExecutionIdentity } from './agent/provider.js'

export interface RunnerCapabilities {
  providerSelectionVersion: number
  providers: AgentProvider[]
  readOnly: boolean
}

// Best-effort uid lookup for a run-user name. Returns null if the name is unset,
// unknown, or resolves to root (executionIdentity throws on uid 0).
function uidOfRunUser(username: string | undefined): number | null {
  if (!username) return null
  try {
    return executionIdentity(username).uid
  } catch {
    return null
  }
}

// The read-only account is only isolated if its uid is non-root AND differs from
// every account that runs writable (credential-bearing) agents. A shared uid would
// let a read-only task reach the writable account's repos / credentials, defeating
// the whole isolation model (finding 10).
export function readOnlyIsIsolated(roUid: number, runUserUids: (number | null)[]): boolean {
  if (roUid === 0) return false
  return !runUserUids.some(uid => uid !== null && uid === roUid)
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

// Resolve the configured read-only account (READONLY_RUN_USER), or null. Fails closed
// when the account is not isolated from the writable run accounts or is root.
export function resolveReadOnlyIdentity(): ExecutionIdentity | null {
  const ro = readOnlyIdentityFor(config.readonlyRunUser)
  if (!ro) return null
  const runUids = [uidOfRunUser(config.claudeRunUser), uidOfRunUser(config.codexRunUser)]
  if (!readOnlyIsIsolated(ro.uid, runUids)) return null
  return ro
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
