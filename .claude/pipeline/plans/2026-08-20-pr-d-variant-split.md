# Plan: PR-D — generic → variant stock assignment (one mechanism, two entry points)

> Authored by Fable 5 on 2026-08-20. Status: APPROVED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

A wholesaler receives a case of a _generic_ product (e.g. "Cola 24pk") and only
later splits it into the specific variants they actually stock (Cherry, Diet,
Zero). Today there is no way to do that: a variant is just another `Product` row
with `parentProductId` set and its own independent `currentStock`, and nothing in
the system moves stock from a parent to its variants. Operators are stuck either
mis-stocking everything on the generic or hand-adjusting each product separately
(two unlinked adjustments, no audit trail tying them together).

Build **one** atomic server operation that moves stock from a parent product to
its variants, and invoke it from **two** entry points so behaviour is identical
either way. Partial assignment is first-class: assign 12 of 20 and leave 8 on the
generic, forever if you like.

**"Unassigned stock" is not new state.** It is simply the parent product's own
`currentStock` — stock sitting on the generic that has not been attributed to a
variant yet. Do not add a column or a derived table for it.

## Constraints & conventions

- **Stack**: npm + Turbo monorepo. NestJS 11 + Prisma 7 API (`apps/api`), Next.js
  14 App Router web (`apps/web`), Expo/RN mobile (`apps/mobile`).
- **No migration.** Everything needed already exists in the schema.
- **Tests**: Jest (`apps/api/src/**/*.spec.ts`, `apps/mobile/__tests__/*.test.ts`).
  Use `createMockPrisma()` from `apps/api/src/testing/prisma-mock.ts`. Mobile tests
  are **pure-logic only** — no render harness. No snapshot tests, no Vitest.
- **Prettier**: semicolons, double quotes, `printWidth` 100, trailing commas.
- **Money/cost discipline**: costs are 4dp via `costDecimal`; averages via
  `nextAverageCost`; both from `apps/api/src/inventory/costing.ts`. Money via
  `roundMoney` from `apps/api/src/common/pricing.ts`. Never introduce a second
  rounding path.
- **Tenancy**: `this.prisma.forTenant()` injects `tenantId`. **Nested creates
  bypass that injection** and land `tenantId = null`, invisible to `forTenant()` —
  so write child rows directly, one at a time, never nested.
- **No new dependencies.**

### Facts established by recon (trust these; do not re-derive)

- `Product.parentProductId String?` (schema ~905), self-relation
  `parent`/`variants` (~950-951), `@@index([parentProductId])` (~973). The model is
  **one level only** in practice: `products.service.bulkAssignParent` (~792-799)
  rejects a parent that is itself a variant. Nothing else enforces depth.
- `products.service.create()` (~443-545) inherits from the parent, when the DTO
  leaves them unset: `priceTier2..5`, `category`, `isTobacco`, `costingMethod`,
  `standardCost`, `unitsPerBox`, and the regulated set
  (`trackedCategoryId`, `trackedSubcategoryId`, `regItemType`, `regUomCase`,
  `regUomUnit`). It does **not** set `currentStock` or `averageCost` — a new
  variant starts at 0 stock, null cost. **Reuse this method to create a new
  variant; do not hand-roll inheritance.**
- `MovementType` has **no TRANSFER value** (PURCHASE / SALE / ADJUSTMENT / RETURN /
  WRITE_OFF / COST_BASIS). A transfer must be composed of paired ADJUSTMENT
  movements sharing one `reference`.
- `applyStockCountItemsInTx` (`inventory.service.ts` ~377-465) is the closest
  existing template for an atomic multi-product adjustment: it keeps a
  `runningStock` map, writes one ADJUSTMENT per non-zero delta under a shared
  `reference`, and opens a `StockLot` on a positive delta.
- `planLotConsumption(lots, qty, fallbackUnitCost)` (`costing.ts` ~83-110) is a
  **pure** lot-drawdown planner already used by `recordSale`. Mirror
  `recordSale`'s usage exactly for the parent side of the transfer.
- `nextAverageCost(currentStock, currentAvg, qty, unitCost)` (~32-41) resets to
  `unitCost` when stock ≤ 0.
- **STANDARD-costed products must never have `averageCost` overwritten** —
  `recordPurchase` (~185) and the vendor-bill receive path both guard with
  `costingMethod !== CostingMethod.STANDARD`. Match that guard.
- `StockMovement.reference` has no unique index. Existing grouping conventions:
  `STOCK_COUNT-<sessionId>` with an idempotency guard
  (`stockMovement.findMany({ where: { reference } })` before writing).

## Work packages

File lists are DISJOINT.

### WP1 — API: the atomic variant-assign operation

- **files:** `apps/api/src/inventory/inventory.service.ts`, `apps/api/src/inventory/inventory.controller.ts`, `apps/api/src/inventory/dto/variant-assign.dto.ts`, `apps/api/src/inventory/variant-assign.spec.ts`
- **brief:** Add `POST /inventory/variant-assign` (OPERATOR-only, same guards as
  the sibling inventory routes) and `InventoryService.assignToVariants`.

  **DTO** (`variant-assign.dto.ts`):

  ```ts
  export class VariantAssignmentDto {
    /** Existing variant to receive stock. Mutually exclusive with newVariant. */
    @IsOptional() @IsString() productId?: string;
    /** Create a new variant of the parent instead. Name only — everything else
     *  is inherited by products.service.create(). */
    @IsOptional() @ValidateNested() @Type(() => NewVariantDto) newVariant?: NewVariantDto;
    /** Base units to move. Omit when sending boxes/pieces. */
    @IsOptional() @IsNumber() @Type(() => Number) @Min(0) @Max(9_999_999.999) qty?: number;
    @IsOptional() @IsInt() @Min(0) @Max(100_000) @Type(() => Number) boxes?: number;
    @IsOptional() @IsInt() @Min(0) @Max(100_000) @Type(() => Number) pieces?: number;
    /** Rare: this variant cost more/less than the generic. 4dp. */
    @IsOptional() @IsNumber() @Type(() => Number) @Min(0) @Max(1_000_000) unitCostOverride?: number;
  }
  export class NewVariantDto {
    @IsString() @MaxLength(120) @StripHtml() name!: string;
  }
  export class VariantAssignDto {
    @IsString() parentProductId!: string;
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(100)
    @ValidateNested({ each: true })
    @Type(() => VariantAssignmentDto)
    assignments!: VariantAssignmentDto[];
    @IsOptional() @IsString() @MaxLength(500) @StripHtml() notes?: string;
  }
  ```

  **Service behaviour** — all inside ONE `this.prisma.tenantTransaction(async (tx) => …, { timeout: 60_000 })`:
  1. Load the parent with `tx.product.findUnique`. 404 if missing.
     **400 if `parent.parentProductId != null`** — a variant of a variant is
     impossible in this model; message: `"A variant cannot itself be split"`.
  2. Resolve each assignment's qty. When `boxes`/`pieces` are present, recompute
     via `normalizeBoxesPieces({ boxes, pieces, unitsPerBox: parent.unitsPerBox })`
     — a boxed generic must never be assigned as loose pieces. Skip assignments
     resolving to qty ≤ 0.
  3. **Validate the pool inside the transaction** (re-validating here is what makes
     concurrent assignments safe):
     ```ts
     const totalQty = assignments.reduce((s, a) => s + a.resolvedQty, 0);
     if (totalQty > Number(parent.currentStock)) {
       throw new BadRequestException({
         code: "INSUFFICIENT_UNASSIGNED",
         message: `Only ${parent.currentStock} unassigned in stock; tried to assign ${totalQty}`,
       });
     }
     ```
  4. Resolve each target: an existing `productId` **must be an active child of THIS
     parent** (`tx.product.findFirst({ where: { id, parentProductId } })`) — 400
     otherwise, so stock can never be moved into an unrelated product. A
     `newVariant` is created by calling the **existing** `productsService.create()`
     with `{ name: <parent.name> + " - " + newVariant.name, variantName: newVariant.name, parentProductId }`
     so the documented inheritance applies; `InventoryModule` must import
     `ProductsModule` for that (check for a circular import — if one exists,
     instead create the row directly with an explicit copy of the inherited field
     list documented above, and say so in a comment).
  5. **Lots are conserved, not invented.** This is a transfer, not a receipt:
     draw the parent's lots down with `planLotConsumption` exactly as `recordSale`
     does, and open one `StockLot` per variant for its assigned qty at the cost
     resolved in step 6. Do not open a variant lot without consuming parent lots.
  6. **Cost**: each variant's unit cost is `unitCostOverride ?? parent.averageCost ?? 0`,
     through `costDecimal` (4dp). Update the variant's `averageCost` via
     `nextAverageCost(variant.currentStock, variant.averageCost, qty, unitCost)`
     — **but only when the VARIANT is not STANDARD-costed**:
     ```ts
     // STANDARD products are valued from their operator-set cost; a transfer must
     // not move it. Mirrors recordPurchase and the vendor-bill receive path.
     const updatesAverage = variant.costingMethod !== CostingMethod.STANDARD;
     ```
     The **parent's** `averageCost` is never changed — removing units at the
     average cost does not move the average.
  7. **Movements**: one negative ADJUSTMENT on the parent for the TOTAL, and one
     positive ADJUSTMENT per variant, all sharing
     `reference = "VARIANT_ASSIGN-" + <uuid>` (generate with `crypto.randomUUID()`).
     Stamp `avgCostAfter` on each the way `applyStockCountItemsInTx` does. Notes
     should name the counterpart, e.g. `"Assigned from <parent.name>"` /
     `"Split into variants"`, plus `dto.notes` when given.
  8. Update `currentStock` on the parent (decrement total) and each variant
     (increment its qty).
  9. Return `{ reference, parentProductId, parentRemaining, assignments: [{ productId, variantName, qty, unitCost, created: boolean }], movementIds }`.
  10. After the transaction commits, call `this.fireStockAlerts(<variant ids that gained stock>)` — never inside the transaction.

- **specs** (`variant-assign.spec.ts`, new file) — all must fail without the fix:
  1. Assigning more than the parent holds throws `BadRequestException` with code
     `INSUFFICIENT_UNASSIGNED` and writes **nothing**.
  2. A partial assignment leaves the remainder on the parent
     (`parentRemaining` correct, parent decremented by exactly Σqty).
  3. Parent movement is negative for the total; one positive movement per variant;
     **all share one `VARIANT_ASSIGN-` reference**.
  4. Targeting a product that is not a child of this parent throws 400.
  5. Splitting a product that is itself a variant throws 400.
  6. A boxed generic assigned as `{boxes: 2, pieces: 3}` with `unitsPerBox: 12`
     moves 27 base units, not 2.
  7. `unitCostOverride` is used for that variant's lot/cost; without it the
     parent's `averageCost` is used.
  8. A STANDARD-costed variant does **not** get its `averageCost` overwritten.
  9. **Lot conservation**: Σ parent lot drawdown equals Σ variant lot qty created.

### WP2 — API: surface "this bill line's product has variants"

- **files:** `apps/api/src/vendor-bills/vendor-bills.service.ts`, `apps/api/src/vendor-bills/vendor-bills-variant-hint.spec.ts`
- **brief:** A bill line's `product` is selected as a minimal
  `{ id, name, sku, unit }` at every read site, so no client can tell whether the
  mapped product has variants. Widen **only `findOne`** (~1049) — not the list, not
  the other write sites — to add `_count: { select: { variants: true } }` and
  `parentProductId`, so the bill detail page can show a "Generic — split into
  variants?" affordance. Keep the response shape backward-compatible (additive
  fields only).
- **spec:** new file asserting `findOne` returns the variant count on a line whose
  product has children, and `0`/absent for one that does not.

### WP3 — web: the shared split sheet + API hook

- **files:** `apps/web/components/VariantSplitModal.tsx`, `apps/web/lib/api/variant-assign.ts`
- **brief:** One reusable modal, invoked from all web entry points so behaviour is
  identical everywhere.
  - **Convention**: hand-roll the overlay (`fixed inset-0 z-[200]`, panel
    `max-w-2xl`) exactly like `apps/web/components/GroupAsVariantsModal.tsx` —
    **do not** use `Modal` from `@routeflow/ui/web`, which is capped at `max-w-lg`
    and too narrow for a table of rows. `GroupAsVariantsModal` is the closest
    precedent for a multi-row split form; follow its structure.
  - Props: `{ parent: { id, name, currentStock, averageCost, unitsPerBox, costingMethod }, pool?: number, onClose, onSuccess }`.
    `pool` defaults to the parent's `currentStock`; the bill entry point passes the
    line's received qty instead.
  - Header shows a **shrinking "Remaining: N"** that updates live as rows are
    filled.
  - One row per variant, searchable/filterable, each taking a qty. When
    `unitsPerBox > 1`, offer boxes + pieces inputs following the order-builder
    pattern in `CreateOrderModal.tsx` (~1592-1613: two adjacent number inputs
    joined by `+`, pieces capped at `unitsPerBox - 1`) — there is no standalone
    reusable component for this on web, so mirror that markup.
  - An inline **"New variant"** row taking a name only (everything else is
    inherited server-side).
  - A per-row cost field collapsed behind **"Different cost?"**, so the common
    all-same-cost case is zero extra taps. **Hide the cost field entirely when the
    parent is STANDARD-costed** (its cost is operator-set and must not move).
  - **Over-assignment is blocked live**: each row's input clamps to what remains.
  - On success, toast a summary and render a link to
    `/inventory/movements?reference=<reference>` — the movements page already reads
    a `reference` query param (see `inventory/movements/page.tsx` ~50-55, and the
    stock-count detail page's "View the movements this count wrote →" link for the
    exact pattern to copy).
- **hook** (`lib/api/variant-assign.ts`): `useAssignToVariants()` mutation posting
  to `/inventory/variant-assign`, invalidating `["inventory"]`, `["products"]` and
  `["vendor-bills"]` on success. Match the local hook conventions.

### WP4 — web: the two entry points

- **files:** `apps/web/app/(dashboard)/products/[id]/page.tsx`, `apps/web/app/(dashboard)/inventory/page.tsx`, `apps/web/app/(dashboard)/vendor-bills/[id]/page.tsx`
- **brief:** Wire `VariantSplitModal` (WP3) into three places. Import it; do not
  duplicate any of its logic.
  1. **Product detail** — the "Stock & Cost" card (~1311-1377) gains an
     **"Unassigned stock: N"** row (N = `product.currentStock`) shown **only when
     the product has variants and is not itself a variant**, and the Variants card
     (~2162-2320) gains an **"Assign to variants"** header action opening the modal
     with `pool = product.currentStock`.
  2. **Inventory Stock tab** — the row actions cell (~676-708, currently
     "Set cost · Adjust · Movements · Open product") gains a 5th action,
     **"Assign to variants"**, rendered only for rows whose product has variants
     and no parent.
  3. **Vendor-bill detail** — in the view-mode line-items table (~1209-1292), the
     "Mapped Product" cell (~1250-1260) gains a **"Generic — split into variants?"**
     badge when that line's product has variants (using the count added in WP2).
     Tapping it opens the modal with `pool = ` the quantity received for that line
     (use the existing `lineRemaining`/`qtyReceived` data already on the wire).
     **It must be skippable forever** — never block receiving, never nag; unsplit
     units simply stay on the generic.
- Guard every affordance so it never appears on a product that is itself a variant.

### WP5 — mobile: split sheet + entry point

- **files:** `apps/mobile/components/VariantSplitSheet.tsx`, `apps/mobile/lib/api/variant-assign.ts`, `apps/mobile/lib/variant-split-logic.ts`, `apps/mobile/app/(operator)/products/[id].tsx`, `apps/mobile/__tests__/variant-split-logic.test.ts`
- **brief:** Mobile has **no variants UI at all** today (grep of the product screen
  returns zero variant hits), so this adds the first one. Keep it to the product
  screen — do not touch the mobile vendor-bill screen, which has no per-line UI to
  hang a badge on.
  - **Sheet**: build on the shared `FormSheet`/`FormSection`/`FormField` primitives
    (`apps/mobile/components/FormSheet.tsx`) — the mobile modal convention. Rows use
    **`BoxedQtyBand`** (`apps/mobile/components/BoxedQtyBand.tsx`: Cases stepper +
    Loose-unit stepper, pieces capped at `unitsPerBox - 1`) when the parent is
    boxed, else a plain `QtyStepper`. Use `ProductPickerSheet` if a picker is
    needed. Same rules as web: live "Remaining: N", clamped inputs, inline new
    variant, cost field hidden for STANDARD.
  - **Entry point**: the product detail screen's Stock card (~302-316) gains
    "Unassigned stock: N" plus an "Assign to variants" action, shown only when the
    product has variants and no parent.
  - **After success**: mobile's `showToast` is plain text with no action slot and is
    a **no-op on iOS**, and the mobile movements screen accepts only
    `productId`/`productName` (no `reference`). So show an **in-screen confirmation
    row/banner** with the summary rather than relying on a toast, and link to the
    product's movements by `productId`. Do not add a `reference` param to the
    mobile movements screen in this PR.
  - **Pure logic** (`variant-split-logic.ts`) — extract and unit-test: remaining-pool
    computation, per-row clamping, boxes/pieces → base units, and building the
    request payload (dropping zero rows). Tests in
    `__tests__/variant-split-logic.test.ts`.

## Acceptance criteria

1. `POST /inventory/variant-assign` moves stock atomically from a parent to its
   variants: one negative parent ADJUSTMENT, one positive ADJUSTMENT per variant,
   all sharing a single `VARIANT_ASSIGN-<uuid>` reference.
2. Assigning more than the parent's `currentStock` returns 400 with code
   `INSUFFICIENT_UNASSIGNED` and writes nothing at all.
3. Partial assignment is supported and leaves the remainder on the generic.
4. A target that is not an active child of the given parent is rejected 400; a
   parent that is itself a variant is rejected 400.
5. `boxes`/`pieces` are converted through `normalizeBoxesPieces` against the
   parent's `unitsPerBox` — a boxed generic is never assigned as loose pieces.
6. Variant cost = `unitCostOverride ?? parent.averageCost`; a STANDARD-costed
   variant's `averageCost` is never overwritten; the parent's average never moves.
7. Stock lots are conserved: parent lots are drawn down by exactly the qty the
   variant lots gain.
8. A new variant created inline inherits the parent's fields via the existing
   `products.service.create()` inheritance (price tiers, category, unitsPerBox,
   costing, regulated fields).
9. Web: the modal is reachable from the product detail page, the inventory Stock
   tab row, and the vendor-bill detail line badge, and all three render the SAME
   component. The bill-detail path is always skippable and never blocks receiving.
10. Mobile: the product detail screen can split a generic, with boxes/pieces-aware
    rows and clamped inputs; pure logic is unit-tested.
11. No affordance appears on a product that is itself a variant.
12. No migration; no new dependencies; no changes to existing route paths or
    response shapes beyond the additive `findOne` fields in WP2.

## Verification commands

Run from the repo root:

- `npm run verify` — Turbo `check-types`, `lint`, `test` across all workspaces.

Lint must report **0 errors** (pre-existing warnings are expected). All suites pass.

## Risks & rollback

- **Highest risk is the cost/lot maths.** A transfer that opens variant lots
  without consuming parent lots silently inflates lot-based valuation; the
  conservation spec (criterion 7) is the guard. Review that spec closely.
- **Circular import**: `InventoryModule` importing `ProductsModule` to reuse
  `products.service.create()` may cycle. If it does, do not force it — copy the
  documented inheritance list explicitly and leave a comment saying why.
- **Concurrency**: two operators splitting the same generic at once must not
  oversell the pool. The pool check happens inside the transaction against a
  freshly-read `currentStock`; do not hoist it out.
- **Rollback**: the server operation is additive (a new route + method) — reverting
  the endpoint plus the three web entry points and the mobile screen removes the
  feature entirely, leaving stock exactly where it was. Movements already written
  remain as an honest audit trail of adjustments that really happened.
