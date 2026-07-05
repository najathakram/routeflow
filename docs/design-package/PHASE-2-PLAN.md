# Phase 2 — Operator core (build plan + tracker)

Spec: `project/specs/pos-cost-roles-spec.md`. Designs: `unified/{order-builder,pos-flow,operator-dashboard,
orders-list,order-detail,customers,customer-detail,products,product-detail,inventory-hub,dispatch,returns}.html`.
Most screens already exist (mature app) → Phase 2 = reskin 1:1 + add the new behaviors.

## Key current-state facts (from gap analysis)
- **Cost accounting shipped (PR #111):** `apps/api/src/inventory/costing.ts`, `recordSale` snapshots
  (SALE `StockMovement` stamps `unitCost`/`avgCostAfter`/`stockAfter`), `Product.averageCost`
  Decimal(10,4). Cost history: `GET /analytics/cost-history/:productId` → `{date,unitCost,avgCostAfter,type}`.
- **Costing method is PER-PRODUCT** (`Product.costingMethod` enum FIFO|LIFO|AVCO|STANDARD, default FIFO),
  NOT per-tenant. Spec wants a tenant default WEIGHTED_AVERAGE(=AVCO)|FIFO|LAST_COST; LAST_COST is new.
- **`averageCost` is ALREADY exposed** on the web `Product` type (`lib/api/products.ts`) → builder has cost.
- **No margin floor anywhere**; no Category entity (`Product.category` is free-text String).
- Builder = `orders/_components/CreateOrderModal.tsx` (create) + `orders/[id]/page.tsx` `PriceEditRow`
  (edit) + `invoices/new/page.tsx` (parallel). Price memory via `useCustomerPriceHistory`.
- `OrderItem.overrideReason` exists (free-text discount reason; edit path only).

## Decisions
- **No migration for margin config:** store in `SystemConfig` key-value (like tobacco toggle):
  `margin.floor.default`, `margin.floor.category.<cat>`, `costing.method`. Additive, safe.
- **Margin math via `pricing.ts`** (3 mirrors: api/src/common, web/lib, mobile/lib) — box/piece aware
  (cost is per-piece; price may be per-box → divide box price by unitsPerBox). Money-discipline rule.
- **"Sell anyway"** logs via `overrideReason` + an AuditLog `SALE_BELOW_FLOOR` (isolate below-floor sales).

## Sub-plan status
- **§1 Live cost/margin (negotiation floor)** — CORE DONE + VERIFIED this increment:
  1. ✅ `pricing.ts` (3 mirrors: api/common, web, mobile) + spec: `costPerSellingUnit`,
     `computeMarginFraction` (box/piece aware), `priceForMarginFloor`, `classifyMargin`. 19 pricing
     tests pass incl. the exact design example ($21.60 box / $0.58 pc / 24-case → 35.6%).
  2. ✅ API margin config via `SystemConfig` (no migration): `SystemConfigService.get/setMarginConfig`
     (keys `costing.method`, `margin.floor.default`, `margin.floor.category.<cat>`); `GET /settings/margin`
     (operator/driver) + `PATCH /settings/margin` (TENANT_ADMIN, spec §4). Web `useMarginConfig()` +
     `floorForCategory()` in `lib/api/margin.ts`.
  3. ✅ Builder `CreateOrderModal.tsx`: `<MarginHint>` renders `cost $X.XX · margin %` under each catalog
     line; red on below-cost/below-floor; **"Set to floor $Y"** one-tap fix (sets discounted price via
     `priceForMarginFloor`); **"Sell anyway"** dismisses the warning. `unitCost`(averageCost)+`category`
     threaded into the line. Verified: typecheck + lint + `/orders` compiles 200.
  - Follow-on (TRACKED, not done): (a) same hint in `orders/[id]` `PriceEditRow` + `invoices/new`
     (needs `averageCost`/`unitsPerBox`/`category` threaded through the order-item DTO → `EditItemState`;
     `overrideReason` already persists there so "Sell anyway" can log server-side + AuditLog SALE_BELOW_FLOOR);
     (b) LAST_COST costing method in `recordSale` (latest PURCHASE movement); (c) cost-tap → cost-history
     popover (`useCostHistory` → existing `GET /analytics/cost-history/:id`); (d) customer-detail Price
     Memory margin column; (e) admin Settings "Costing & Margins" tab (method + default + per-category
     floors via `useUpdateMarginConfig`); (f) analytics label costing method + effective-date changes.
  - **Verification limit:** the live hint can't be seen end-to-end locally (needs operator login + seeded
     products with cost). Correctness is covered by the pricing spec + typecheck + compile; the visual
     hint should be screenshot-verified once an authed session is available.
- **§2 Minimize & resume drafts** — NOT STARTED. Needs `sale_drafts` store + endpoints + web DraftDock
  provider in shell + autosave + scan-to-draft. (Analysis agent failed on size; analyze lightly when reached.)
- **§3 At-the-door actions** — NOT STARTED. Arrived-stop sheet (adjust/new/collect-payment) on dispatch.
- **§4 Roles / Drive mode** — NOT STARTED. `canActAsDriver`, avatar Drive-mode toggle, server-side
  driver capability set, admin's own run in Live Dispatch.
- **Ledger reskin** of the 10 operator-core screens — NOT STARTED (structural/column/copy deltas; tokens
  already match from Phase 1).

## Acceptance (pos-cost-roles-spec §Acceptance) — track here
- [~] Cost method configurable (tenant): tenant setting stored + API (`/settings/margin`) done; recordSale
      still keys off per-Product method (LAST_COST + tenant-default precedence = follow-on). WAC ✓ + per-line
      cost_at_sale snapshots ✓ (#111).
- [~] Builder live cost/margin per line ✅ (create path); floor warning + one-tap fix ✅; overrides logged
      = client dismiss done, server AuditLog = follow-on (edit path has overrideReason). Edit/invoice
      builders = follow-on.
- [ ] Minimize/resume across screens/devices/offline; scan-to-draft prompt. _(§2, not started)_
- [ ] At-door adjust → save & POD ≤2 taps; invoice regenerates incl. regulated split. _(§3, not started)_
- [ ] Drive mode one-tap; driver capability set enforced server-side (RolesGuard already maps
      canActAsDriver→DRIVER); admin sees own run in Live Dispatch. _(§4, not started)_
- [ ] Ledger reskin of the 10 operator-core screens. _(not started — tokens already match)_
