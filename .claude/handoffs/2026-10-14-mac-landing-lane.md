# Mac mini landing lane: handoff 2026-10-14 (wind-down at 91% weekly)

Rules held: sole pusher, normal hooks, never --no-verify / force push / git stash; full shas only from command output.
Ports 3310/3311 (stack stopped). Containers rf_b297_pg and rf_azm_redis are STOPPED (start for DB work).

## PRs (state at handoff)
| PR | Branch @ head | Worktree | State |
|---|---|---|---|
| #3464 | test/multi-label-proof @ 2e7758b5b | ~/code/rf-wt-ml | SA PASS, rides train S3 |
| #3467 | fix/product-page-roles @ 71120f0db | ~/code/rf-wt-pp | SA FINAL PASS at 69ed4628d, plus the unlink DTO fix (f85524215) and the H2 merge (71120f0db). HARD ORDER: #3468, then H2 #3457, then #3467. PC lane assembles TRAIN S3; do NOT push to #3468/#3467/#3465/#3464 while S3 assembles |
| #3468 | fix/tier-commit-cascade @ cc8355d69 | ~/code/rf-wt-p0 | P0 money. SA FINAL PASS on code; captures done (PR comment, PNGs in local-assets/apple-ux/2026-10-14-p0-tier-cascade). Conflicts with #3467 in products/[id]/page.tsx (the train resolves it) |
| #3470 | fix/list-price-tier-cascade @ f5296fb6f | ~/code/rf-wt-lc | Stacked on #3468 (base fix/tier-commit-cascade); retarget to master after #3468 merges. SA review MUSTs 1-4 + variant one-list SHOULD folded at f5296fb6f; awaiting the SA's re-pass. Open: the behavioural quick-save test (page not mountable; source pins + helper payload test instead) |

SA follow-ups logged by the Lead (not started): R1 unlink composes the standalone name server-side; scheduled federal rules also protect labels; disable a list row's tier cells while its quick-save is pending.

## In progress: the census script (read-only, owner-run)
Worktree ~/code/rf-wt-census, branch chore/report-tier-freeze (on master e6aec7cd7). apps/api/scripts/report-tier-freeze.mjs is WRITTEN, uncommitted, and works: --self-test ok; a local fixture (DBs rf_census_tmp + rf_census_bak on rf_b297_pg; seed at scratchpad census-seed.mjs) gave freeze 4.00 ESTIMATE, and with TIER_BACKUP_PG 1 copy-down confirmed, 1 cleared, 1.75 over. TODO: add it to B768_REPORTS in owner-report-db-url.spec.ts, run that spec, open it as a separate read-only follow-up PR (Lead: default_transaction_read_only, tenant ids only, the live-target guard). Waiting for the Lead's go (wind-down at 91%).
Plan: apps/api/scripts/report-tier-freeze.mjs on the B768 resolver (scripts/lib/report-db-url.mjs), plus its row in
apps/api/src/common/owner-report-db-url.spec.ts B768_REPORTS (never the DATABASE_URL allow-list). Template: report-addon-comp-candidates.mjs
(SET default_transaction_read_only, statement/lock timeouts, ids + counts only, isTestTenant tags, --self-test, --json).
Sections:
- FREEZE (list raise left tiers behind): all non-zero tiers 2-5 equal and < list; earliest `PATCH /products/<id>` audit (AuditLog action, entityType "products"; no before/after values exist).
- OVERWRITE (A, tier copy-down): updatedAt >= --since (default 2026-07-30) and some T_N > 0 with T_N = T_{N+1}; audit PATCH rows since.
- B: exact diff when TIER_BACKUP_PG points at a scratch DB restored from a backup (owner-run): tiers changed, with the copy-down signature.
- C: sizing via computeLineSubtotal + roundMoney over non-VOID invoice lines since --since; effective tier = CustomerPrice.pricingTier ?? Customer.pricingTier; freeze = undercharge (current list as proxy, labelled ESTIMATE); overwrite = overcharge (exact only with B).
Proof plan: --self-test pure checks, a local fixture run on a qa-* tenant in rf_b297_pg, the guard spec green.
