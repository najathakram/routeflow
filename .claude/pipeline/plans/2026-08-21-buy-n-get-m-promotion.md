# BUY_N_GET_M promotion type — "buy 5, get the 6th free", exactly

**Date:** 2026-08-21 · **Scale:** major · **Migration:** YES (additive: enum value + 1 column)

## Why (owner's words, 2026-08-21)

> "That promotion means, when you buy 5 of the same unit, you get the 6th one free. which
> means, if you buy 12, you get 2 free (11th and 12th unit). we don't give 35 per unit off.
> that's a mistake!!!"

The owner configured "BUY 5 GET 1 FREE" as `FIXED $35 off, scope ALL` because the engine has
no way to express the real mechanic. Result: 699/1,767 products priced $0.00 in the live
buyer portal (promo deactivated 2026-08-21 as an emergency fix; zero $0 orders were placed).
This feature makes the intended mechanic expressible so the promo can be recreated correctly.

## The mechanic (binding)

- Type `BUY_N_GET_M`: for every **(N + M) whole selling units of the same product on a line**,
  M units are free. `freeUnits = floor(qtyUnits / (N + M)) * M`.
  - N=5, M=1: 5 units → 0 free; 6 → 1; 11 → 1; 12 → 2; 18 → 3. (Owner's exact examples.)
- **Selling units, not pieces**: for a boxed product a "unit" is a BOX; loose pieces NEVER
  count toward N and are never given free. For piece products, units = pieces.
- **Field reuse — NO new Promotion columns**: `minQty` stores N (buy quantity), `value`
  stores M (free quantity, integer ≥ 1). Documented at the enum + DTO + UI. Validation:
  for this type require integer `minQty ≥ 1` and integer `value ≥ 1`.
- **Money is EXACT, never a net-unit-price approximation.** A per-unit net price for
  35 × 5/6 = 29.1667 rounds to 29.17 and drifts cents when multiplied back. Instead the
  line keeps its true `unitPrice` and the free units reduce the SUBTOTAL:
  `subtotal = computeLineSubtotal(qty - freeUnits-worth, ...)` — concretely,
  `computeLineSubtotal` gains an optional `freeUnits` parameter (default 0) that subtracts
  `freeUnits` whole selling units before pricing. 12 boxes @ $35 with 2 free =
  `roundMoney(10 × 35) = $350.00`, exact. The saving is `freeUnits × unitPrice`, exact.
- **Non-stacking, best-of, consistent with today**: `applyBestPromotion` picks the single
  promo with the LARGEST saving for the line's current quantity. A BUY_N_GET_M result
  carries `unitPrice = base` (unchanged), `originalPrice = null`, and a new `freeUnits`
  field; PERCENT/FIXED/QTY_BREAK results carry `freeUnits: 0` and their existing shape.
  Savings comparison: price-promos save `(base - net) × qtyUnits`; BOGO saves
  `freeUnits × base`. Ties → promo id order (deterministic, as today).
- Persistence: **`OrderItem.promoFreeUnits Int?`** (sale-time snapshot, like `unitsPerBox`).
  Order edit/reprice recomputes it; invoice lines derive from the order verbatim (#181) so
  the exact subtotal flows through — WP2 must VERIFY no invoice path recomputes
  `qty × unitPrice` for a promoFreeUnits line and pin that with a spec.
- Display: unit price is never faked. Tiles/detail show the promo's `bannerText` as the
  deal chip (no fake "-N%" for this type); carts and order/invoice lines show
  "N free" against the line (e.g. "12 boxes · 2 free") and the exact reduced subtotal.

## Binding contracts

- `PromotionType` gains `BUY_N_GET_M` (Prisma enum + the string union in all three pricing
  mirrors + `packages/types` if the union exists there — grep first).
- `PromoContext` gains `qtyUnits: number` — whole selling units on the line (boxes for a
  boxed line — mixed lines count ONLY full boxes; qty for piece lines). Every existing
  caller of `applyBestPromotion`/`deriveTilePrice` must populate it (grep all callers in
  all three apps; the tile context uses the would-be-added quantity: 1 box / 1 piece, or
  the cart item's current quantity when present, mirroring today's qtyPieces sourcing).
- `PromoResult` gains `freeUnits: number` (0 for non-BOGO). The pricing block stays
  **byte-identical across apps/api/src/common/pricing.ts, apps/web/lib/pricing.ts,
  apps/mobile/lib/pricing.ts** — the header comment says so and it stays true.
- `computeLineSubtotal(..., freeUnits = 0)`: subtracts `freeUnits` WHOLE selling units
  before pricing; never negative (clamp freeUnits to available whole units); byte-identical
  in the three mirrors; every existing call site is unaffected (default 0).
- Migration: single additive SQL — `ALTER TYPE "PromotionType" ADD VALUE 'BUY_N_GET_M';`
  - `ALTER TABLE "OrderItem" ADD COLUMN "promoFreeUnits" INTEGER;` (nullable, no backfill).
    Name it `20260821xxxxxx_add_buy_n_get_m_promotion`. NOTE for ship (not for agents):
    applies to prod BEFORE the app deploy.

## Work packages

### WP1 — pricing engines (the three mirrors + their specs)

**Files:** `apps/api/src/common/pricing.ts`, `apps/web/lib/pricing.ts`,
`apps/mobile/lib/pricing.ts`, `apps/api/src/common/pricing.spec.ts`,
`apps/mobile/__tests__/pricing-parity.test.ts` (create if absent — check for an existing
mobile pricing spec first and extend it instead).
Implement the contracts above: `BUY_N_GET_M` in the type union, `qtyUnits` in PromoContext,
`freeUnits` in PromoResult, the floor formula in `promoNetPrice`'s sibling (a BOGO branch
that yields `{net: base, freeUnits}`), savings-comparison in `applyBestPromotion`, and the
`computeLineSubtotal` freeUnits parameter. Specs pin: the owner's exact table (5→0, 6→1,
11→1, 12→2), pieces-never-count (boxed line 5 boxes + 40 pieces with N=5,M=1 → 0 free…
until 6 whole boxes), exactness ($35 base, 12 boxes, 2 free → $350.00 — assert the FIXED
$29.17-style drift is impossible), best-of vs a PERCENT promo both directions, value/minQty
validation guards (non-integer or <1 → promo ignored, never a crash), and the byte-identical
mirror rule (the api spec may read the web/mobile files and diff the marked block — there is
prior art in the repo for mirror-parity specs; follow it if found, otherwise assert on the
exported behavior in mobile's spec).

### WP2 — API: schema, migration, order engine, DTO

**Files:** `apps/api/prisma/schema.prisma`,
`apps/api/prisma/migrations/<stamp>_add_buy_n_get_m_promotion/migration.sql`,
`apps/api/src/orders/orders.service.ts`, `apps/api/src/promotions/**` (DTO + service
validation — locate the module; if promotions CRUD lives elsewhere, follow the controller),
`apps/api/src/orders/orders-promo-bogo.spec.ts` (new).
Order create + every edit/reprice path that calls `applyBestPromotion`: thread `qtyUnits`,
persist `promoFreeUnits`, compute subtotal via the extended `computeLineSubtotal`. A line
with freeUnits keeps `priceType: PROMO`, `unitPrice = base`, `originalPrice = null`.
VERIFY invoice derivation copies the order line subtotal verbatim for such lines (and the
#288 resync path) — pin with a spec. DTO: creating/updating a BUY_N_GET_M promo requires
integer minQty ≥ 1 and integer value ≥ 1, else 400 with a clear message.

### WP3 — web: admin form + buyer-facing display

**Files:** `apps/web/app/(dashboard)/promotions/page.tsx`, `apps/web/lib/buyer-cart.ts`
(only if line-total display math lives there), the buyer cart page
`apps/web/app/buyer/portal/[seller]/cart/page.tsx`, and
`apps/web/app/buyer/portal/[seller]/shop/_components/tile-pricing.ts`.
Admin form: type selector gains "Buy N get M free" with two integer inputs labeled
"Buy quantity (N)" and "Free quantity (M)" mapping to minQty/value, plus a live sentence
preview ("Buy 5, get 1 free — every 6th unit is free"). Buyer cart: lines show
"{freeUnits} free" and the exact reduced total; tile/detail chip for a matching BOGO promo
shows the promo bannerText (fallback "Buy N get M free"), never a percent. tile-pricing
threads qtyUnits into the context (1 unit when not in cart; the cart item's units when
present — consistent with how qtyPieces is sourced today).

### WP4 — mobile mirrors

**Files:** mobile buyer/customer cart + order-builder surfaces that render promo pricing
(locate via `applyBestPromotion`/`deriveTilePrice`-equivalent callers under `apps/mobile` —
the code map's mobile.md lists the cart/order-entry files), plus
`apps/mobile/__tests__/` spec for any pure logic moved/added.
Mirror WP3's display semantics exactly (web is golden): "{freeUnits} free" on lines, exact
totals, banner-text chip. NO navigation/UX redesign — display parity only.

## Acceptance criteria

1. A promo with N=5, M=1, scope ALL prices NOTHING at $0.00 and changes NO unit price;
   a 12-unit line of a $35 product totals exactly $350.00 everywhere (tile→cart→order→invoice).
2. Pieces never earn or receive free units; only whole selling units count.
3. `npm run verify` green; new specs cover the owner's quantity table and the invoice-verbatim rule.
4. The three pricing mirrors remain byte-identical in the marked block.
5. Admin can create the promo with plain-language N/M fields; buyer sees the banner chip and
   "N free" in the cart; existing PERCENT/FIXED/QTY_BREAK behavior is bit-for-bit unchanged
   (pin: a regression spec re-runs an existing promo scenario and asserts identical output).
6. Migration is additive-only and safe to run before the app deploy.
