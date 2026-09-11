# RESUME card - 2026-09-10-train4-run-d

Written BEFORE launch, per dev-pipeline S7 / bug-pipeline S6. A killed session cannot be asked for these later.

- **Run**: train 4 Run D - B131 removed-customer crons keep firing + B141 removed-customer keeps portal access
  (no token revocation). bug-pipeline, `mode: bugfix`, scale `major`. S4/S5 by Opus 5 (Fable out of credits, 429).
- **runId**: recorded here immediately after the Workflow tool returns.
- **Engine scriptPath**: `local-assets/tooling/pipeline-2026-09-06-6d31a370.js` in the MAIN checkout.
- **args**: exactly `.claude/pipeline/2026-09-10-train4-run-d/pipeline-args.json` in this directory (3,856 bytes,
  under the ~4.5 KB resume-truncation line), plus `startedAt` set at launch and
  `workdir: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F25"`. Re-pass them from disk on resume; never recover
  them from the run record.
- **Branch / worktree**: `fix/train4-removed-customer` in `.claude/worktrees/rf-F25`, off master `5b3b3c4e`.
- **Launch order**: after the damage-report run; before Run C.

## Lead review 2026-09-10

Approved as-is; grounding citation corrected to `5b3b3c4e`; launch after the damage-report run, before Run C.

## LAUNCHED 2026-09-10T22:08:55Z

- runId `wf_30255189-af9` (task wboupahiy), startedAt 2026-09-10T22:08:25Z, workdir C:/ClaudeCode/routeflow/.claude/worktrees/rf-F25, engine local-assets/tooling/pipeline-2026-09-06-6d31a370.js, args = this dir pipeline-args.json (3856 B, flag-order corrected) + startedAt + workdir. Resume: Workflow scriptPath + resumeFromRunId wf_30255189-af9 + the same args.
