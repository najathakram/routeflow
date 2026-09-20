# Handoff — Mac Lane R-service (2026-09-20)

**Step:** LANE-R step 2 (one choke point + meta-spec), slice 2a-8 (`approveChangeRequestAtStop`). Dark: `selling_restrictions.enabled` stays OFF.

## Unpushed / at-risk work (read first)

- Worktree `~/code/routeflow/.claude/worktrees/rf-lane-R-service-3` — branch `feat/r-2a-8-door-edit`.
  - `3b08f3a1` (the door edit) is PUSHED to `origin/feat/r-2a-8-door-edit`; do not rebuild it.
  - Merge of `origin/master` (`df6ccf62`) pushed as `e415826c` (real pre-push hook green). This card commit is pushed once the PR body names its sha.
  - No PR yet at time of writing; if none is on the board, open it from this branch.
- Worktree `~/code/routeflow/.claude/worktrees/rf-lane-R-service` — branch `feat/r-1-selling-restrictions-service` (old session). Has UNCOMMITTED edits to `apps/api/src/selling-restrictions/selling-restrictions.core.ts` and `packages/types/api/restrictions.ts`, ahead 1 / behind 132 of origin. NOT mine this session, untouched; step 1 shipped long ago, so these are likely stale. Owner decides.

## State

- Branch merged with `origin/master` (`df6ccf62`); no conflicts.
- `orders.service.ts` = 5871 lines vs size-ratchet baseline 5880 (cap 5905) — fits, baseline untouched.
- Proof at this head: `tsc --noEmit` clean; jest `orders.change-request-restrictions`, `size-ratchet`, `selling-restrictions*`, `orders-promo-bogo` = 12 suites / 328 tests green.
- Opus refute-first review of the door edit: SHIP-WITH-NITS, nits folded (recorded in 3b08f3a1's message).

## Next

1. Push, open the 2a-8 PR (body: scope, flag, proof, not covered; Opus verdict above), post `[R-service@mac] PR` on #938.
2. Remaining step-2 rows in `sellable-writers-coverage.spec.ts` (PENDING count; was 12 after this slice) — one PR each.
3. Then LANE-R step 3 (`normalize-address-states.mjs`).
