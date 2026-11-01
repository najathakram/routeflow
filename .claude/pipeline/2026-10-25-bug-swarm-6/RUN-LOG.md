## 2026-10-25-bug-swarm-6 · v1.2 Workflow · 6 rows requested, 3 fixed · about $2.11/bug

**Batch.** Rows 302, 734, W-694 fixed (PRs #3755, #3757, #3758, one-row clusters, all web). 674 fixed on master,
W-879 unclear (not reproduced), 535 skipped (its file is open in another PR). 18-file avoid list from open PRs.

**Cost (true telemetry, partial).** Workflow $3.74 (+1.13 M haiku tokens unpriced) + orchestrator $2.59 up to
the workflow end = $6.33, **$2.11 per fixed bug** (runs 1-5: $3.42, $5.05, n/a, $2.56, $2.34). Orchestrator
share about 0.41. Wall clock of the workflow about 9 min.

**Quality.** gate.mjs green first pass x3; Opus review PASS x3 with no MUSTs; no SPEC-EDIT. Pre-push verify green
x3 (one hit a stale Prisma client in a fresh worktree on the timer branch, fixed with `prisma generate`).

**Baseline.** No true-telemetry bug-pipeline LOW rows exist (estimates only, about $17.7 per small run), so the 0.5x
adoption test still cannot be decided on ledger numbers; the swarm is at or below every prior swarm run per bug.

**Wasted.** 3 of 6 rows built nothing (1 already fixed, 1 unclear, 1 file clash): the pre-screen knob from run 5 was
only half applied; the lane picked from truncated `rf ls` titles again. Pushes cost more wall clock than the swarm
(one heavy-slot verify per branch, about 4 min each).

**Candidate knob (run 5 + 6, 2 runs).** Pre-screen: drop rows whose gate says "verify on master" and run the
open-PR avoid-list BEFORE triage so a clash row never reaches Triage+Pack. CI could not run on #3755 (Actions
spending limit); landing waits for a window.
