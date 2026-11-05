import { Router } from 'express'

export const capabilitiesRouter = Router()

// Versioned contract, not a claim that either CLI is authenticated.
// Static discovery must never probe login state or start runner operations.
capabilitiesRouter.get('/capabilities', (_req, res) => {
  res.json({ providerSelectionVersion: 1, providers: ['claude', 'codex'] })
})
