# Landing order — window-5 queue (2026-09-18)

Written by Lane E at the fleet lead's request, for whoever fills the landing-coordinator
seat next. This is a written order, not an authorization — the coordinator still runs the
actual merge/visibility-flip sequence from `docs/runbooks/deploy-visibility-flip.md`.

## Order (code PRs first, registry last)

1. **#897** — `fix/B516-grid-cols-responsive` (title says B534, PR body itself was renumbered
   B523→B534 after an id collision, see commit `ccd3dd78` on that branch). MERGEABLE per `gh pr
   view`. No stated blocker. Land first — #910 is stacked on its file set.
2. **#910** — `fix/B535-tap-target-hit-areas`. MERGEABLE. **States its own dependency in the PR
   body**: "Lands after #897 (B534, grid-cols responsive fix) — same six files, built on a fresh
   branch off current master rather than stacked on #897's branch." Land immediately after #897.
3. **#909** — `fix/A7-marketing-nav-consistency` (Lane A — dead CSS + footer drift guard,
   B537/B538). MERGEABLE. No dependency on #897/#910 (different files — marketing, not
   dashboard). Can land in either order relative to them; sequenced here for one clean batch.
4. **#908** — `fix/B533-buyer-portal-table-scroll`. MERGEABLE. **Gated on Lane F's 390px proof**
   per the lead — confirm Lane F (routeflow-23) has posted that proof before landing this one.
   Do not land ahead of the proof landing.
5. **Lane B's two PRs** (not yet opened as of this writing) — getStats() `deletedAt` fix (B543)
   and the `mrr.service.ts` stale doc-comment correction (B544). B545
   (`activateManualSubscription()` no-delta gap) is filing-only, no PR. Confirm Lane B
   (routeflow-3a) has pushed before including in the window.
6. **#901** — the consolidated registry PR (this branch). **Lands LAST, always** — registry
   bookkeeping documents code that has already landed, never code that might. Before landing,
   rebase onto whatever master sha the code PRs above actually produced (not the sha at the time
   this doc was written) and re-verify entry ids the same way this session did (diff ids across
   every folded-in branch, never eyeball).

## Known open item NOT in this window

- **B524** (server-side `requires` enforcement for `driver_payments`, the twin of B519's
  client-side warning already landed via #899) is reported by the lead as sequenced **after
  Lane B's DTO PR** — Lane E has not independently verified this dependency; confirm with Lane B
  or the lead before scheduling it.

## Verification method used to build this list

Each PR's `state`/`mergeable` checked via `gh pr view <n> --json state,headRefName,mergeable`
fresh at write time (2026-09-18, ~09:20 local). `mergeable: MERGEABLE` is GitHub's own computed
merge check against the CURRENT base branch, not a guarantee against sibling PRs in the same
queue — re-check after each landing, not just once at the top of the window. #901's own registry
content was verified id-complete against all 6 folded-in source PRs (#896, #903-#907) by diffing
entry ids programmatically, not by eyeballing — see PR #901's commit history for the method.
