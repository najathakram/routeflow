# Row 704: product price-grid skeleton mis-sized (start card, 2026-10-22, Mac mini lane)

> **PARKED (lead, 2026-10-22):** P3; it stays on file for a lane that frees up. No code written yet.
> Lead's sequencing for whoever picks it up: measure on ONE host (option a, rebuild own stack) only when no other compose
> stack is up; check for a findOne query-count/perf pin first (none found in products.service.spec.ts, which only mocks
> findUnique); qa-* tenant for the Base/Box/Pallet product; keep disk ≥ 10 GB.
> Design found: the row count = `buildLadderView(product, units).rows.length`. Rows don't depend on `opts` (orderUnit and
> tierOrderUnits only set the anchors), so findOne can count them with one `productUnit.findMany` using
> `UNIT_PRICE_SELECT` (exported from product-price-grid.service.ts ~:75). Best as a small exported helper there, so the
> grid and the count can never drift.

**Lead card (P3, from R3 K16 FE1):** the loading skeleton is short: md+ band ~130 px, phone cards ~1 rem, and on a
first visit it undercounts extra units (e.g. Pallet). Carry the row count in the product payload so the skeleton is
right on a first visit (`seenRowCount` resets on reload). Keep CLS at 0. Measure skeleton vs loaded heights at
1440/768/390 before and after, from ONE host. Whole web jest (+ api) through `node scripts/heavy-slot.mjs`, Option B
trailer, real hooks, PR (tier 2, not draft) with captures.

**Branch:** `fix/row-704-price-grid-skeleton` in ~/code/rf-wt-r3img, cut from master b977de134. No commits yet.
Rebuild packages first (`npx turbo run build --filter='./packages/*'`): a reused tree's built pricing goes stale.

**Overlap check (done):** #3535/#3541 touch products/[id]/page.tsx, and #3535 also touches packages/types/api/products.ts
and products.controller.ts. Avoid all three. Free files: ProductPricesGrid.tsx, ProductUnitsCard.tsx (UnitsCardProduct),
apps/api/src/products/products.service.ts (findOne).

**Code map of the fix:**
- web `products/[id]/ProductPricesGrid.tsx` ~:65-100: `seenRowCount` (module Map), `estimateRowCount` (2 when
  unitsPerBox > 1, else 1), and `GridSkeleton` with h-[17.5rem] cards (<md) and an h-9 header + h-[4.75rem] rows (md+).
  It's used at ~:564; `seenRowCount.set` is at ~:587.
- The row count is NOT the ProductUnit count. The grid rows come from `priceGrid(buildLadderView(product, units, ...))`
  in `apps/api/src/products/product-price-grid.service.ts` `read()` (~:121-177), which includes an implicit piece row
  that no unit backs. The payload count must use the same ladder (a shared helper, or findOne reading the same view).
- The heights are set from measurements, not guesses (lead: md+ short by ~130 px, cards by ~1 rem).

**Measure host (asked the lead, no answer yet):** (a) rebuild my own api+web in rf-wt-r3img on the shared :5432 DB,
with a qa-* product carrying Base/Box/Pallet, measured before (master) and after; or (b) the landing lane's
3310/3311 for "before". Disk is ~19 GB (rule 20); a web build adds ~1.4 GB. After a `next build`, copy .next/static
and public into the standalone dir, and move `.next/types` aside before pushing.

**Pending elsewhere:** the #3563 blast-radius pin edit waits on the OWNER's yes in the original Mac mini lane session
(the landing lane's classifier refused it; never do it on a relay). PRs #3564 (merged), #3565 and #3570 are frozen for reviews.
