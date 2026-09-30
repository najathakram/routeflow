# Lane notes — lite-L2-plan (build lane under routeflow-c4)

RESUME.md is engine-owned (auto-checkpointed) — this file carries the build-lane's own tracking
notes instead. Recreated 2026-09-15 after a prior version was cleared by an engine checkpoint.

- runId: wf_2a4511df-6e1, 17 tasks incl. WP14 (the checkout-webhook fix, lead condition 3).
- Launch #1 (wyvbw0iaj): aborted at plan validation (WP10 spec-file-in-both-arrays). Fixed.
- Launch #2 (wutt5443m): **CRASHED** on old engine sha 857a9d4d — Baseline fully passed (all
  pre-existing suites green, confirms the task graph is sound), then WP1's Author-tests agent
  completed without StructuredOutput and the engine crashed the whole run:
  `TypeError: null is not an object (evaluating 't.status')` at workflow.js:2781. Reported to c4
  → designated **engine defect E8**.
- Launch #3 (wckyimkbm): resumed on the still-old sha per c4's "one resume is fine" — stopped
  mid-run once c4 sent "engine E8 re-staged" (new sha 52bf7a7a8f86ad0dcf70d927c7dc1e411cb2cf6e6
  90d65518c269efc3c04f077, 202,888 B) so it wouldn't complete on a retired engine copy.
- Copied the new staged engine into this worktree, verified sha matches canonical, relaunched.
- Launch #4 / first E8-fixed run (wvoe2pqux): running, awaiting result. Per c4: if WP1's
  test-author again returns no StructuredOutput, the task now blocks CLEANLY (one blocked task
  - `(engine)` blocker + error detail, siblings continue, run finishes) instead of crashing — if
    that happens, send c4 the blocker detail for a ruling rather than retrying blind.
- Also fixed along the way: build-plan.md's file-path typo
  (apps/api/src/billing/publish-plan-catalog-v11.ts → apps/api/prisma/publish-plan-catalog-v11.ts),
  flagged by the grounding pass.
