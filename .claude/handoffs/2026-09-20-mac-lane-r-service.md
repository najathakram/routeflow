# Handoff — Mac Lane R-service (2026-09-20)

**Step:** LANE-R step 2 (one choke point + meta-spec), slice 2a-8 (`approveChangeRequestAtStop`). Dark: `selling_restrictions.enabled` stays OFF.

## Unpushed / at-risk work (read first)

- **UNPUSHED:** worktree `~/code/routeflow/.claude/worktrees/rf-lane-R-service-4`, branch `feat/r-2b-template-call-site`, commits `15f16716` + `aa963f1d` review nits (Opus refute: SHIP-WITH-NITS; nits 1,2 fixed; 3-5 noted for PR body) (standing orders skip-and-notify restricted lines, coverage row -> GUARDED, + typed `ChangeRequestFacts.type`). Local only ON PURPOSE: the Mac Lead said do not push until #1124 lands (both PRs edit `PENDING_BASELINE`; after #1124 lands, rebase/merge master, set baseline 12 -> 11, then push). Not on any remote — if this session dies, the work is only in that worktree.
- Worktree `~/code/routeflow/.claude/worktrees/rf-lane-R-service-3` — branch `feat/r-2a-8-door-edit` = PR #1124, fully pushed (head 4920037a), MERGE-WITH-NOTES, awaiting landing.
- Old worktree `rf-lane-R-service` was removed by the Mac Lead (branch `feat/r-1-selling-restrictions-service` kept); patches of its uncommitted edits are in the session scratchpad (`old-r-service-*.patch`), nothing unique in them.

## State

- Branch merged with `origin/master` (`df6ccf62`); no conflicts.
- `orders.service.ts` = 5871 lines vs size-ratchet baseline 5880 (cap 5905) — fits, baseline untouched.
- Proof at this head: `tsc --noEmit` clean; jest `orders.change-request-restrictions`, `size-ratchet`, `selling-restrictions*`, `orders-promo-bogo` = 12 suites / 328 tests green.
- Opus refute-first review of the door edit: SHIP-WITH-NITS, nits folded (recorded in 3b08f3a1's message).

## Next

1. Push, open the 2a-8 PR (body: scope, flag, proof, not covered; Opus verdict above), post `[R-service@mac] PR` on #938.
2. Remaining step-2 rows in `sellable-writers-coverage.spec.ts` (PENDING count; was 12 after this slice) — one PR each.
3. Then LANE-R step 3 (`normalize-address-states.mjs`).
