# RESUME card - 2026-09-10-train4-run-c

Written BEFORE launch, per dev-pipeline S7 / bug-pipeline S6. A killed session cannot be asked for these later.

- **Run**: train 4 Run C - B216 Stripe reinstatement disarm (billing). bug-pipeline, `mode: bugfix`, scale small.
- **runId**: recorded here immediately after the Workflow tool returns.
- **Engine scriptPath**: `local-assets/tooling/pipeline-2026-09-06-6d31a370.js` in the MAIN checkout.
- **args**: exactly `.claude/pipeline/2026-09-10-train4-run-c/pipeline-args.json` in this directory (2,663 bytes,
  under the ~4.5 KB resume-truncation line), plus `startedAt` set at launch and
  `workdir: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry"`. Re-pass them from disk on resume; never
  recover them from the run record.
- **Branch / worktree**: `fix/train4-billing-reinstatement` in `.claude/worktrees/rf-registry`, off master `edd379bf`.
- **Launch order**: after Run A (train4-run-a) and the damage-report run; before Run B.

## Lead review 2026-09-10

Approved for launch after Run A and the damage-report run; stays based on edd379bf, merge master at landing
(drift since edd379bf = apps/api/jest.repo-truth.config.js + apps/api/package.json only, benign).

> Amended 2026-09-10 (lead review): --reporters=default added to both Jest commands per L-063.

## LAUNCHED 2026-09-11T00:46:52Z

- runId `wf_8c4a091b-52d` (task wg5dfsu2i), startedAt 2026-09-11T00:52:00Z, workdir C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry, engine local-assets/tooling/pipeline-2026-09-06-6d31a370.js, args = this dir pipeline-args.json (flag-order corrected) + startedAt + workdir.
