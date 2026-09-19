# Fleet Lead Handoff — 2026-09-18 evening → cold start

`$SCRATCH` = `C:\Users\nakram\AppData\Local\Temp\claude\C--ClaudeCode-routeflow\20f39e54-c9b5-4469-a28a-cb7ec44dff13\scratchpad` (session-temp, will be cleaned up)

## ▶ START HERE
1. `git fetch && git log -1 origin/master` → confirm `6f49cbf5` (local checkout was stale at `06752f88`).
2. Check if owner answered the two open questions below before planning around them.
3. Verify no lane running: only **#912** `chore/report-mrr-ledger-drift` open. 45+ stale dirs under `.claude/worktrees/` — run `worktree-audit.mjs`.
4. **First task:** copy `$SCRATCH`'s units/PO plan + reviews to `local-assets/handoff/2026-09-18/` before cleanup deletes it.

## State at close (verified)
`origin/master`=`6f49cbf5`, PRIVATE. PRs merged today: **57** (`gh search prs --merged -- "merged:2026-09-18"`, #860–#931) — brief said 28, trust the repo. Railway SUCCESS + post-deploy-check green (apex-DNS warning B542 known) — carried from brief, **not re-checked**.

## What shipped (spot-checked)
Buyer-portal scroll (B533/#908) · platform-admin tab-strip overflow (B559/#925) · marketing copy+screenshots (#871/#924) · entitlement `requires` enforcement (B519/B524, #899/#913/#915) · credit-note cache invalidation (B343/#898) · dashboard soft-delete counts (B543/#911) · MRR planKey+ledger compensation (B556/B557/#926) · B562 interim UI mitigation (#931) · lessons compaction, verified 53,447B/~52KB, was ~65KB (#922) · ~15 more mobile 390px/tap-target fixes in #860-#931.

## Open, needs owner
- **Units/PO Q3**: unit picker in v1? Open. Factor immutability: ANSWERED, immutable.
- **Apex DNS**: `routeflow.info` has no apex record; zone in Google Cloud DNS (SOA `cloud-dns-hostmaster.google.com`), not in project `routeflow-506615` — owner locating right project. Needs ALIAS `routeflow.info.`→`o6wb5dm5.up.railway.app.` (not www's `wpjy3lc3...`) + TXT `_railway-verify`=`railway-verify=bb9a3edb59949feb7e6120e10bebd2dc093cbce71dcd67243c3bd869c71606d0`. gcloud/API only. *(not re-verified)*
- **Scanner redesign**: SPEC FIRST, not started. Research at `$SCRATCH\mobile-scan-research.md` (save it too): `apps/web`/mobile Safari not Expo; `@zxing/browser`; no camera constraints/focusMode; rear camera via `devices[last]`; ~300-line row inline in `CreateOrderModal.tsx` must be extracted first.

## Priority bugs (per `.claude/campaign/bugs.jsonl` @ origin/master)
- **B562** critical/money, open — recompute-costs replay is blind to raw order stock decrements, overwrites `Product.averageCost`/`stockAfter`, destroys its own audit trail; not recoverable. UI hidden (#931), root cause remains. Fix before PO-edit work.
- **B523** high, open — campaign-check red repo-wide (30 undischarged REG-B### claims). **Discrepancy**: brief's "mobile.json staleness" theory isn't in the actual registry text — verify root cause first.
- Also open: B558/B560/B561 (Extend Trial UX + money + concurrency trio, one button) · B563 (post-deploy-check has zero platform-admin coverage).

## The units/PO plan
Final v4 + v1-v3 + six review files in `$SCRATCH`: `PLAN-units-po-v{1..4}.md`, `REVIEW-{A,B}-round{1,2,3}.md`. Scores per brief (not re-derived) 4/4/5/6/6/3→8/8/8/8/9/7. Cost ≈113 lane-days, 9-10 wks @ 4 lanes. Owner answered: two docs on scan; backfill funded; factors immutable. **Save this set — top priority.**

## Process notes
- Verify merges via `merge-base --is-ancestor <sha> origin/master` — a "merge master into branch" commit isn't a landing.
- Batch registry filings — mid-window admits forced three rebases on `bugs.jsonl`'s append point.
- Recurring pattern (4x today): a check reports clean while structurally blind to what it tests. New assertion → prove it fails when the bug is reintroduced.
- Wrapper exit 0 ≠ git's exit code — read real push output.
