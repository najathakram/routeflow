# M3 (#2754) retarget prep — dry-run findings (read-only, 2026-09-29)
Inputs: master c38f2b013, M2 head 07e9aca65 (#2741 open, base master), M3 head 24c749982 (base feat/2717-m2-recipes). M1 (#2733) is merged.
Dry-run: `git merge-tree --write-tree` of M2 onto master = CLEAN (tree a8abc59a). Then M3 vs a simulated "M2 landed on master" merge commit = 7 conflicts (M2 will squash-land, so M3's older M2-era copies conflict with the final M2 content).

## Conflicts and resolutions
| file | resolution |
|---|---|
| .claude/code-map/_meta.json | mappedSha only: take master's newest stamp (a master sha, an ancestor) |
| packages/pricing/src/index.ts | union: keep M3's `export * from "./component-pieces"` next to master's exports |
| apps/api/src/orders/orders.service.ts (one hunk ~3460) | keep M3's call `buildReplaceAllPairing(order, dto)`; DROP the inline B60 block that master re-added; port #2753's only change INTO the extracted function: apps/api/src/orders/replace-all-line-build.ts ~451 `bogoCounterparts.set(li.productId, {…})` → `bogoCounterparts.set(li.productId, buildBogoCounterpart(li))` (buildBogoCounterpart already exists at :44 on master; git auto-merged that file). Re-check the import list for an unused/missing name. |
| products/family-price.spec.ts, products.read-fallback.spec.ts, recipes-product-guards.spec.ts, recipes-update-guards.spec.ts | CORRECTION (lead, 09-29): M2's specs already register the shared `entitlementAuthorityFromEntitlements` provider (my grep for the token `EntitlementAuthority` missed it). Take M2's side for the provider wiring; drop M3's own swap; keep only M3-authored cases if any differ. Never both providers |
No conflicts in migrations, prisma schema folder, bugs.jsonl, web/mobile files.

## Migrations
Order OK: master last = 20260928230000_2717_m1…; M2 = 20260929120000_2717_m2_recipes; M3 = 20260929180000_2717_m3_documents sorts after both. M3's file is byte-identical to the frozen sha 5bc06fca….
SA-582 wrap (static read of the file): exactly one `BEGIN;` (line 23), one `SET LOCAL lock_timeout = '5s';` (24), one `COMMIT;` (105, last statement), nothing outside the wrap: satisfies the #2771 rules (exactly one each, in order). NOT executed: #2771's script depends on scripts/lib/set-local-exempt-migrations.json from another unmerged PR, and its squawk half needs the toolchain; run `node scripts/lint-migrations.mjs` once #2771 is on master.

## DI-only reds
The 13 M2-spec reds are the four products specs above: on M2's head they still provide EntitlementsService while products.service.ts takes EntitlementAuthority. No swap is needed once M2 is underneath (M2's specs already wire the provider): resolve to M2's side.

## Exact steps (when the lead says M2 has landed)
1. git fetch; confirm origin/master contains M2's squash. Worktree off origin/feat/2717-m3-documents.
2. `git merge origin/master` (plain merge, NEVER rebase/force). Resolve the 7 files per the table. Keep the Option-B trailer on HEAD.
3. Regenerate: `npx prisma generate` (apps/api), `npm run build -w packages/pricing -w packages/types`.
4. Run singly: line-composition.spec, order-composition-buyer-scope.spec, the 4 products specs, line-units-callsites.spec, size-ratchet + enum-parity + no-bare-cron + addon-gate specs, buyer page.test, OrderLineItemsTable tests; `npm run check-types -w apps/api` (0, spec baseline).
5. Regen campaign api.json if stale (`cd apps/api && npx jest --maxWorkers=2`), then push (normal pre-push verify), fast-forward.
6. `gh api -X PATCH repos/najathakram/routeflow/pulls/2754 -f base=master`; edit the body (drop the "carries #2756" note, keep the tier-1 + migration notes); post the new head on #2554.
7. F2 re-runs the DB lane on the retargeted head; then CI; then the owner's migration (fresh backup first: the M3 migration adds 2 tables + 6 columns, additive).
