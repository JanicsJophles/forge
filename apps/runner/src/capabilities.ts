import type { AgentProvider } from '@forge/shared'

// Advertised by GET /tasks/capabilities so Atlas can enable the read-only option
// only for runners that actually enforce it. Versioned contract, not a claim that
// either CLI is authenticated.
export const runnerCapabilities: {
  providerSelectionVersion: number
  providers: AgentProvider[]
  readOnly: boolean
} = {
  providerSelectionVersion: 1,
  providers: ['claude', 'codex'],
  readOnly: true,
}
