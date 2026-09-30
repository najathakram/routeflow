# Plan: three tier-blind pricing paths (money-sensitive)

> Status: IMPLEMENTED (2026-08-23, autopilot; clean=true, 7 findings fixed in 1 round, gate green 2610 tests) · Authored 2026-08-23 from the verified 2026-08-22 recon. This file is the ONLY
> context implementers receive. Root causes are CONFIRMED — implement, do not re-investigate.

## ⚠️ WORKTREE — read before anything else

ALL work happens in:

```
C:\ClaudeCode\routeflow\.claude\worktrees\ap-tier-gaps
```

Your process may start in `C:\ClaudeCode\routeflow` (main checkout) — do NOT touch files there.
`cd` into the worktree before ANY command; use ABSOLUTE paths under the worktree for every file
read/edit. Relative paths in this plan are relative to the worktree root. Branch is already
`fix/tier-pricing-gaps`; do not commit, stage or push — the orchestrator handles git.

## Objective

Per-customer tier auto-pricing exists (`Customer.pricingTier` + `CustomerPrice`,
`getTierPrice`), but three edit paths ignore it, so a client concluded the feature doesn't work.
Every fix here changes what customers are charged — spec everything, run the FULL test suite.

## Post-MSRP hazard (applies to every package)

`CustomerPrice.pricingTier` is NULLABLE since the MSRP merge — a row may be
`{ pricingTier: null, msrp: X }`. Every tier lookup must fall back to the customer's default tier
for such rows (`cp.pricingTier ?? customer.pricingTier ?? 1`), never crash, never fall to list.

## Work packages

### WP1 — SERVER: `updateOrderItems` operator branch resolves tiers (files: `apps/api/src/orders/orders.service.ts`, `apps/api/src/orders/orders.service.spec.ts`)

Confirmed defect: the operator/admin branch of `OrdersService.updateOrderItems`
(~L2692-2884 — BOTH the replace-all sub-branch ~L2705-2800 AND the individual-item-update
sub-branch ~L2801-2884) does `const catalogPrice = Number(product.pricePerUnit)` and never loads
`Customer.pricingTier`/`CustomerPrice`. New/replaced lines price at LIST. The `isBuyerEdit`
(CUSTOMER role) branch of the SAME function already resolves tiers correctly — mirror it, and
mirror how `create()` (~L1478-1696) does it.

Implementation:

1. Once per call (outside any item loop), when the acting role is operator/admin, load the order's
   customer with `pricingTier` and its `CustomerPrice` rows for the involved productIds.
2. For each NEW or REPLACED line where the caller did NOT supply an explicit unit price (or
   supplied exactly the list price — read how the buyer branch distinguishes; follow the same
   convention), resolve the price through the same helper the create path uses
   (`getTierPrice`/`resolveBuyerLinePrice` — read both and use the one the operator create path
   uses). Apply the null-tier fallback from the hazard note.
3. Price-type labeling: a tier-resolved price is `PriceType.SPECIAL`, NOT `MANUAL`. `MANUAL` is
   reserved for a genuinely operator-typed override (it feeds remembered-price history via
   `getCustomerPriceHistory` and must not be polluted by tier prices). Preserve existing
   explicit-override behavior exactly.
4. Specs (extend `orders.service.spec.ts`, Prisma-boundary mocks, money asserted to the cent):
   (a) operator adds a line for a tier-3 customer with no explicit price → tier-3 price, SPECIAL;
   (b) operator supplies an explicit different price → that price, MANUAL;
   (c) `CustomerPrice` row `{ pricingTier: null, msrp: 5 }` → customer's default tier price;
   (d) buyer-edit branch behavior unchanged (regression pin — one existing assertion re-run is
   enough if the suite already covers it; add one if not).

### WP2 — WEB: order-edit "Add Item" uses the tier (files: `apps/web/app/(dashboard)/orders/[id]/page.tsx`)

Confirmed defect: `addProduct()` (~L834-874) computes
`const startPrice = hist ? hist.lastPrice : catalog` — tier-blind. The substitute-picker flow in
the SAME file (~L1182) already does `unitPrice: tierPriceFor(p)` (with a comment referencing the
2026-08-19 fix). Change `addProduct` to `hist ? hist.lastPrice : tierPriceFor(p)`, falling back to
catalog only if `tierPriceFor` cannot resolve. Do not change the substitute flow. Mobile's
equivalent is already correct — do not touch mobile.

### WP3 — WEB: invoice edit page resolves tiers (files: `apps/web/app/(dashboard)/invoices/[id]/edit/page.tsx`)

Confirmed defect: this page has ZERO tier logic. All three product-selection paths set unit price
straight from the catalog: barcode scan (~L87), list-pick (~L116), inline-created product (~L743).
Mirror the `tierLadderPrice`/`priceMap` approach used by `apps/web/app/(dashboard)/invoices/new/page.tsx`
(the create page — read it first; it was fixed in PR #340 for exactly this defect): fetch the
customer's tier + per-product `CustomerPrice`, compute the tier price per product, use it at all
three call sites when the operator has not typed a price. Server-side `invoices.service.ts` stays a
verbatim-trust model for direct invoice edits — do NOT change the API in this package.

## Explicitly OUT of scope — do not touch

The two known boxed-overcharge bugs in the same `updateOrderItems` region (fresh-add and substitute
paths re-deriving `qty*unitPrice` for boxed lines) are separately tracked with their own briefs —
DO NOT attempt them here; if you see them while editing, note their exact locations in your report
and leave the code alone. Mobile files. `.claude/code-map` (orchestrator updates it).

## Acceptance criteria

1. WP1 specs (a)-(d) pass; the full existing orders + pricing suites pass unmodified.
2. Web order-edit add-item and invoice-edit product selection produce the tier price for a tiered
   customer with no operator-typed price.
3. No API surface changed except `orders.service.ts` internals; no schema change; no migration.
4. `git status` in the worktree shows changes ONLY in the four listed files.

## Verification commands (from the worktree root)

```
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-tier-gaps && npm run check-types
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-tier-gaps && npm run lint
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-tier-gaps && npm run test
```
