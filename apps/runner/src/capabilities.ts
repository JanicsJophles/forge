import type { AgentProvider } from '@forge/shared'
import { containmentAvailable } from './agent/cgroup.js'
import { config } from './config.js'
import { executionIdentity, type ExecutionIdentity } from './agent/provider.js'

export interface RunnerCapabilities {
  providerSelectionVersion: number
  providers: AgentProvider[]
  readOnly: boolean
}

export interface AccountId {
  uid: number
  gid: number
}

// Resolve a run-user name to its uid+gid. Returns null if the name is unset, unknown,
// or resolves to root (executionIdentity throws on uid 0).
function identityOfRunUser(username: string | undefined): AccountId | null {
  if (!username) return null
  try {
    const id = executionIdentity(username)
    return { uid: id.uid, gid: id.gid }
  } catch {
    return null
  }
}

// The read-only account is only isolated if BOTH its uid and gid are non-root AND
// differ from every account that runs writable (credential-bearing) agents. A shared
// uid OR gid would let a read-only task reach the writable account's repos /
// credentials (group-readable too), defeating the isolation model (finding 10 / H).
//
// FAIL CLOSED: a run-user name that does not resolve (getent failed) is treated as a
// POTENTIAL collision — we cannot prove the read-only account is distinct from it, so
// isolation is refused rather than assumed (finding H).
export function readOnlyIsIsolated(ro: AccountId, runUsers: (AccountId | null)[]): boolean {
  if (ro.uid === 0 || ro.gid === 0) return false
  if (runUsers.some(u => u === null)) return false
  return !runUsers.some(u => u!.uid === ro.uid || u!.gid === ro.gid)
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
  if (!ro || !readOnlyIsIsolated(ro, [identityOfRunUser(config.claudeRunUser), identityOfRunUser(config.codexRunUser)])) return null
  return containmentAvailable() ? ro : null
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
