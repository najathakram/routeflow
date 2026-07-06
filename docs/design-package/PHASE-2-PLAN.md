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
  - ✅ Admin **Settings → Costing tab** (`CostingTab` in settings/page.tsx): costing method +
     default margin floor, via `useMarginConfig`/`useUpdateMarginConfig` (admin-gated). Closes the
     "cost method configurable (tenant)" acceptance line. (PR #117)
  - ✅ **Drive mode entry (§4)**: avatar-menu one-tap → `/routes/my-runs` for `canActAsDriver`
     (capability already enforced by RolesGuard). MVP entry point; full field-layout swap = follow-on. (PR #117)
  - ✅ Edit-path margin hint (PR #118): `orders/[id]` `PriceEditRow` renders the shared
     `components/MarginHint.tsx` (also the at-door adjust path); order `findOne` selects product
     `averageCost`+`category`; "Sell anyway" persists `overrideReason` (logged). Reused across builders.
  - ✅ Customer Price Memory margin column (PR #118): customer detail > Special Prices shows margin
     (their price vs cost now), colored vs the tenant floor; `getCustomerPrices` selects `averageCost`+
     `unitsPerBox`. Closes §1 bullet 3.
  - Follow-on progress: **(c)(d)(e) DONE (PR #120)** — `lib/api/cost-history.ts` `useCostHistory(productId)`
     (products/[id] `CostHistoryCard` refactored onto it); shared `MarginHint` gained a tap-the-cost
     **cost-history popover** (portaled to `<body>` to escape the builder modal's transform+overflow);
     `CreateOrderModal` now uses the shared `MarginHint` (inline dup deleted, `productId` threaded); analytics
     **Gross Margin** card states the tenant costing method (`useMarginConfig`, effective-dated note).
  - **(b) LAST_COST DONE (branch `feat/last-cost-costing`)** — `CostingMethod` enum gains `LAST_COST`
     (**additive migration `20260706040000_add_costing_last_cost`** = `ALTER TYPE ... ADD VALUE`; touches no
     table/row; **NOT yet applied to prod**). `recordSale` LAST_COST branch: cost = most recent **PURCHASE
     StockMovement** `unitCost` (typed, `orderBy [createdAt desc, id desc]` — NOT the latest StockLot, which
     could be an adjustment/stock-count lot stamped at avg cost; the money-path review caught this), fallback
     averageCost; not lot-consuming. 2 new inventory.spec tests (335 api tests pass). Selectable per-product (products/page.tsx picker option); DTO auto-accepts via
     `@IsEnum(CostingMethod)`. Effective-dating is intrinsic (per-line `cost_at_sale` snapshot immutable;
     method changes affect only future sales). **Deferred follow-on:** propagate the tenant `costing.method`
     to NEW products at creation (cross-module wiring — the tenant setting is stored + selectable but doesn't
     auto-apply to products yet; see QUESTIONS.md #10).
  - **(a) invoices/new hint — STILL TODO, blocked on a box-model finding:** invoices/new's boxed `unitPrice`
     semantics are ambiguous (`qty` is total pieces and `lineTotal = qty×unitPrice`, yet the `/pc` display
     divides `unitPrice` by `unitsPerBox` — they disagree on per-box vs per-piece). Adding a margin hint on
     top risks a WRONG margin; pin down/fix that box model first, then add the hint.
  - **Verification limit:** the live hint can't be seen end-to-end locally (needs operator login + seeded
     products with cost). Correctness is covered by the pricing spec + typecheck + compile; the visual
     hint should be screenshot-verified once an authed session is available.
- **§2 Minimize & resume drafts** — BACKEND DONE; **UI DONE (this increment), verify post-deploy.**
  - ✅ Schema: `SaleDraft` model (per-user, tenant-scoped, `payload` Json) + **additive** migration
    `20260705120000_add_sale_drafts` (CREATE TABLE only — touches no existing table/rows). Applied to
    local Docker DB; **prod needs `railway run npx prisma migrate deploy` BEFORE this UI deploys**
    (the dock now queries `/drafts` on every operator screen).
  - ✅ Backend: `drafts` module — `DraftsService` (list/create/update/get/remove, per-user ownership +
    tenant scoping) + `DraftsController` (`/drafts` CRUD, OPERATOR/DRIVER; TENANT_ADMIN satisfies
    OPERATOR so the admin dock works) + `SaveDraftDto`; registered in `app.module`. 5-test spec.
  - ✅ Web hooks: `lib/api/drafts.ts` (`useDrafts`/`useCreateDraft`/`useUpdateDraft`/`useDeleteDraft`
    + `useDraft(id)` for resume-hydration).
  - ✅ **DraftDock** (`components/DraftDock.tsx`): bottom-left of the content area on every operator
    screen (mounted in the shell right-column, non-CUSTOMER roles), lists parked drafts (2 shown +
    collapse badge when >2), Resume → `/orders?resumeDraft=<id>`, Discard → confirm. Hosts the global
    **scan-to-draft** wedge-listener (active only while a draft is parked, bails inside any open
    dialog) → "Add scanned item to a draft?" prompt → resume with `&scan=<code>`.
  - ✅ **Builder wiring** (`CreateOrderModal`): Minimize footer button (parks full state via
    `lib/drafts.ts` `OrderDraftPayload`), resume-hydrate from `payload`, debounced autosave once bound
    to a draft, auto-add the scanned barcode on open, delete the draft on successful submit.
  - ✅ **Orders page**: reads `?resumeDraft` / `?scan` / `?action=new` (reactively, so Resume works
    even when already on `/orders`), opens the builder hydrated, strips the params.
  - **Autosave model:** binds on Minimize/Resume only (never auto-creates from a fresh builder) — see
    QUESTIONS.md #8. Invoice-builder Minimize/resume deferred to Phase 3 (QUESTIONS.md #9).
- **§3 At-the-door actions** — NOT STARTED. Arrived-stop sheet (adjust/new/collect-payment) on dispatch.
- **§4 Roles / Drive mode** — NOT STARTED. `canActAsDriver`, avatar Drive-mode toggle, server-side
  driver capability set, admin's own run in Live Dispatch.
- **Ledger reskin** of the 10 operator-core screens — NOT STARTED (structural/column/copy deltas; tokens
  already match from Phase 1).

## Acceptance (pos-cost-roles-spec §Acceptance) — track here
- [~] Cost method configurable (tenant): tenant setting stored + API (`/settings/margin`) done; recordSale
      keys off per-Product method — now **incl. LAST_COST** (latest lot cost, spec'd). Tenant-default→product
      propagation still a follow-on (QUESTIONS.md #10). WAC ✓ + per-line cost_at_sale snapshots ✓ (#111).
- [~] Builder live cost/margin per line ✅ (create path); floor warning + one-tap fix ✅; overrides logged
      = client dismiss done, server AuditLog = follow-on (edit path has overrideReason). Edit/invoice
      builders = follow-on.
- [~] Minimize/resume across screens/devices/offline; scan-to-draft prompt. _(§2 web done: dock +
      Minimize + resume-hydrate + autosave + scan-to-draft; offline sync rides autosave/react-query;
      mobile + invoice-builder = follow-on. Verify on live `test` post-deploy.)_
- [ ] At-door adjust → save & POD ≤2 taps; invoice regenerates incl. regulated split. _(§3, not started)_
- [ ] Drive mode one-tap; driver capability set enforced server-side (RolesGuard already maps
      canActAsDriver→DRIVER); admin sees own run in Live Dispatch. _(§4, not started)_
- [ ] Ledger reskin of the 10 operator-core screens. _(not started — tokens already match)_
