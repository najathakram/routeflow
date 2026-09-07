# F08 — round 2 (lead-designed; recovery after the engine stall in fix round 1)

Engine `wf_85fd24ba-6e2` stalled 2026-09-06 23:17Z: the MOBILE fix executor (agent a558d7f1; files `apps/mobile/lib/returns-logic.ts`,
`apps/mobile/lib/api/orders.ts`, `apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx`) issued an Edit that never returned after
15 edits. The other six round-1 executors completed (36 fixes; see `journal.jsonl` results). One executor (a2e37b7) reported an INCIDENT:
its line-number probe (`sed -i '586d'`) on `apps/api/src/returns/returns.service.ts` raced the API executor editing the same file and
deleted a DIFFERENT line — integrity of that file is unproven until tsc + the returns specs pass.

## Lead rulings

1. **deliveredQty (the six deferred duplicates): OPTION B — drop it from this PR.** No schema change tonight (a `ReturnItem.deliveredQty`
   column needs a prod migration; the Railway route from this machine is down and Wave A is landing). Remove the `deliveredQty` field
   from `CreateReturnItemDto` (`packages/types/api/returns.ts` if shared, else the api DTO), the branch in `create()` that consumes it,
   the driver-screen field that sends it, and test **T1d** (keep T1e). Refund quantity stays `min(q, B)` on the billed basis (B53 core).
   The B53×B128 composition (post-delivery return on a partially delivered order) is RE-FILED at close-out as a new registry row
   (needs the column + migration). The "derive from OrderItem.deliveredQty" shortcut stays rejected.
2. **Mobile cluster completion:** finish exactly what the stuck executor owed and no more — the driver screen consumes the helper's
   `undeliveredReturnLines(...).payloads` (shaper relocated into `returns-logic.ts` and tested), a per-row Damaged override, real
   `promoFreeUnits` via the order queries in `apps/mobile/lib/api/orders.ts`, null-productId exclusion, `Promise.allSettled` submission
   with a submitted set. Read the three files as they stand first; do not redo what is already there.
3. **Integrity first:** before any edit, run `cd apps/api && npx tsc -p tsconfig.build.json --noEmit` and
   `cd apps/api && npx jest src/returns src/credit-notes --runInBand`; if `returns.service.ts` is broken, repair the race damage by
   reading the file against the executors' recorded fixes (journal results), never by guessing.
4. **`apps/api/src/routes/routes.service.ts` is PROHIBITED** (standing rule for this batch).

## Stages (light loop; ≤ 4 concurrent)

- **A. Assessor + completer (Opus, high):** rulings 1–3 above; then run the perRound gates:
  `cd apps/api && npx tsc -p tsconfig.build.json --noEmit` · `cd apps/api && npx jest src/returns src/credit-notes --runInBand` ·
  `cd apps/mobile && npx tsc --noEmit` · `cd apps/mobile && npx jest returns-logic` · `cd apps/web && npx tsc --noEmit -p tsconfig.json`;
  fix what the stall/race broke (max 3 iterations). Report per ruling.
- **B. Regate (Haiku, low):** the same five commands, verbatim.
- **C. Review (Opus, high, refute-first):** the WHOLE diff (`git status --short` + `git diff` + untracked spec/e2e files) against
  `cause-ruling.md` / `bug-test-plan.md`; verify the 36 executor "fixed" claims by tracing each failure scenario; verify ruling 1's
  removal is complete (no orphaned DTO field, no dead branch, T1d gone, T1e kept); then read the WRITERS and CONSUMERS of the state this
  change touches outside the radius (credit-notes.service, orders.service `completeStop`/delivered basis, the web returns pages, the
  operator mobile screens) — the F18 lesson: the defects that matter live in the consumers. Findings with severity; recommend
  land / one-more-round.
- **D. Final gates (Haiku, low):** `cd apps/api && npx jest --silent` · `cd apps/mobile && npx jest --silent` · `cd apps/web && npx jest --silent` ·
  `node scripts/validate-lessons.mjs`. If exactly one api suite fails and it is `src/common/ci-freshness-guard-script.spec.ts`, re-run
  it alone once and report both (known load flake).

Close-out bindings (unchanged from cause-ruling.md §8) plus: new rows for the B53×B128 composition (column + migration), DRIVER-role
scoping on `GET /returns` (pre-existing), server-side `limit` cap after the `limit: 0` audit.
