# Stuckpoint capture hooks (RAC-378)

The cheapest, self-funding first slice of the autonomous knowledge flywheel
(RAC-376). Passively captures every real agent-run stuckpoint —
symptom → cause → fix → verified-command, **including dead-ends and
confident-wrong turns** — as a `Candidate` on the agent-board, at near-zero
marginal cost. The promotion gate (RAC-380) later folds the survivors into the
skills RAG.

There are **two capture paths emitting to ONE queue** (`POST /agent-candidates`
on the agent-board, LXC 207:5000):

| Path | Hook point | Code |
|------|-----------|------|
| **Forge agents** | `runner.ts` `proc.on('close')` | `apps/runner/src/agent/{capture,extractor}.ts` |
| **Local Claude Code** | `~/.claude/settings.json` `Stop` hook | `hooks/extract-stuckpoints.mjs` (this dir) |

Both run the **same heuristic prefilter**: only when real failure signals appear
(non-zero exits, retried commands, error strings, "that didn't work / actually
the issue is" patterns) is a candidate built. A trivial, no-stuckpoint session
emits **zero** candidates and makes **zero** network calls.

## Candidate schema

Defined once in `packages/shared/src/types.ts` (`Candidate` / `CandidateInput`).
It is a **superset of `rackmind-server`'s `skill.schema.json` `failureMode`**, so
RAC-380 maps it straight onto a `topFailureModes[]` entry in a
`skills/<cluster>.json`:

```
symptom         → failureMode.symptom
cause           → failureMode.likelyCause
diagnosticSteps → failureMode.diagnosticSteps
fix             → failureMode.fix
severity        → failureMode.severity
verifiedCommand   (command-level ground truth)
deadEnds[]        (decision-tree: negative results + confident-wrong turns)
reproduction      (reproducedOnRealInfra:true = highest tier, auto-promote fast-path)
rawEvidence       (audit trail for the gate)
status            ('new' → gate advances it)
source            ('testing-loop' here; 'web-harvest' for RAC-379)
```

## Local install (manual — do NOT let an agent edit your live settings.json)

1. Copy the script into your Claude bin dir:

   ```bash
   mkdir -p ~/.claude/bin
   cp hooks/extract-stuckpoints.mjs ~/.claude/bin/extract-stuckpoints.mjs
   ```

2. Merge the `hooks.Stop` block from `hooks/settings.stop-hook.json` into your
   existing `~/.claude/settings.json` (merge — do not overwrite). If you already
   have a `Stop` hook, append this command to its `hooks` array.

3. (Optional) override defaults via env in the hook command, e.g.
   `AGENT_BOARD_URL=http://192.168.1.208:5000` for LAN, or
   `CAPTURE_ENABLED=false` to disable.

### Defaults

- `AGENT_BOARD_URL` — `http://100.105.173.104:5000` (Tailscale).
- `CAPTURE_ENABLED` — `true`. Set `false` to fully disable.
- Pure Node ≥18, **zero npm deps** (global `fetch`), no build step.

## Forge install

Already wired — `runner.ts` fires `captureStuckpoints(...)` from
`proc.on('close')`, fire-and-forget, after the task's status transition. Tune via
the runner env: `AGENT_BOARD_URL` (default loopback to the co-located board) and
`CAPTURE_ENABLED`.

## Safety contract (both paths)

- **Never blocks** the agent run — capture is not awaited.
- **Never throws** into the caller — every path swallows errors.
- **Board unreachable → silent no-op** (per the agent-board failure-mode rule).
- **3s POST timeout**, then abort.
