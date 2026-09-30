# F13 — dev-pipeline RESUME card

Written BEFORE launch (2026-09-02). The resume key is `{scriptPath, resumeFromRunId, args}` and **args are NOT
stored by the tool** — that is why `pipeline-args.json` sits beside this file. `runId` and the transcript dir are
filled in the moment the Workflow tool result returns.

## Resume key

|              |                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`      | `wf_72a623d9-cd7` (launched 2026-09-02T19:00:58Z from session routeflow-39, `maxConcurrent` lowered to 8 in the staged copy because F11's run was still finishing beside it)                                                                                                                                                                                                          |
| `scriptPath` | `C:\ClaudeCode\routeflow\local-assets\tooling\pipeline-v2.js` — the **upgraded engine** (2026-09-02: explicit model+effort on every agent, lazy refutation, structural red bar, final pass skipped on no-HIGH diffs, Verify ∥ UI verify, lessons-fed lenses, estUsd accounting). `local-assets/tooling/pipeline.js` is the OLD engine F11's live run depends on — never overwrite it. |
| `args`       | `pipeline-args.json` in this directory — pass its parsed contents verbatim as a real OBJECT (a JSON string entity-escapes `&&`). Set `startedAt` to the launch time.                                                                                                                                                                                                                  |
| transcript   | `C:\Users\nakram\.claude\projects\C--ClaudeCode-routeflow\eda3096b-178c-459e-ab22-9897d967e9c0\subagents\workflows\wf_72a623d9-cd7`                                                                                                                                                                                                                                                   |

Branch note (2026-09-03): another session renamed the worktree branch to `fix/F13-recurring-standing-v2` and fast-forwarded its base to F11's merge (`d0769701`) mid-run, stashing and re-applying the tracked files; the run's Verify/probe evidence inside that window is under audit before close-out. stash@{0} is that snapshot — drop it only after the audit.

```
Workflow({ scriptPath: "C:\ClaudeCode\routeflow\local-assets\tooling\pipeline-v2.js",
           resumeFromRunId: "<runId>", args: <contents of pipeline-args.json> })
```

## This run is the first real MAJOR on the upgraded engine

Compare its ledger row with F14 (old engine, 91 agents, ~979k tokens; Gate & Review 255k, Fix 173k, Final pass 87k
from one Fable agent). Expected: Gate & Review / Fix / Verify materially lower; the red gate completes in one attempt
when structurally red; every `phaseReport` row carries `estUsd` and `effort`; `overlap.verifyWithUiVerify` is false
(no `uiVerify` here) and `overlap.finalGateWithFinalPass` true; `finalPass.model` = `claude-fable-5-1` (or the Opus
fallback, recorded). Append the result to `.claude/pipeline/cost-ledger.jsonl` with
`node ~/.claude/skills/model-routing/scripts/pipeline-ledger.mjs append`.

## Lead rulings applied at launch — a builder must not undo these

- SEQUENCE.md R5/R6 (2026-09-02): e2e spec number **30** (`30-recurring-standing`), lesson **L-046** (pre-allocated;
  `nextId` 51 stays unless a second, unallocated lesson is written).
- `order-templates.controller.ts` UNTOUCHED (F14 already removed the DRIVER grants); `apps/api/src/routes/**` untouched.
- `orders.service.ts` diff = exactly the two modifier lines (WP-ORDERS). F11 is live in rf-F11 and edits another
  region of that file — the rebase must stay mechanical.
- Anchors re-verified against master `d4f85fd2` (note atop `build-plan.md`): order-templates.service.ts +8 after :244.

## Setup already done in this worktree — verify, do not redo blindly

- branch `fix/F13-recurring-standing` rebased onto master `d4f85fd2` (0 commits ahead; the planning dir is untracked)
- **its own `npx -y npm@10.8.0 ci`** inside the worktree (mobile deps are nested and invisible otherwise)
- `npx prisma generate` in `apps/api`
- husky `.husky/_` present — commit-msg and pre-push hooks actually run here
- pre-flight of the perRound gates recorded in the session that launched

## Oracles to check individually (a skipped phase is neutral; an UNVERIFIED one is not)

- `redGate.structurallyRed` / `.behaviorallyRed` / `.attempts` — the new two-level verdict; a behavioral shortfall
  forces the probe over all 8 targets instead of a remediation round.
- `mutationProbe.allCaught` / `.restoredVerified` / `.skipped` — 8 targets, all on HIGH-risk money files.
- `finalPass.ran` / `.skipped` / `.model` / `.fallback` / `.completed`.
- `verify` — votes cast vs judged (lazy slate), first-vote refute rate, tie-breaks.
- `baseline.badCommands` — anything here was excluded from pass/fail.
- `uiVerify` — **not configured** (T2 rows are deployed-only e2e; local Playwright is forbidden).

## Owed after the run, regardless of verdict

- Persist the result object to `result.json` here; append the ledger row; write the phase table into the close-out.
- **Before `git push`:** regenerate BOTH campaign artifacts in THIS worktree (`npm --prefix apps/api test`,
  `npm --prefix apps/mobile test`, uncached) — scoped runs leave partial `.campaign/runs/*.json`.
- Ledger flips in `F13.jsonl`: B46, B48, B106 → `proven` (T1, naming REG tests + probes); B09, B92 →
  `proven-pending-deploy` (T2, spec 30). Lesson L-046. Code map entries per build-plan close-out §5.
- Merge goes through the fleet's coordinator (one serial merge lane); D4 prod read is the owner's.
