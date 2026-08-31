# Inventory & Stock Control

_Know what is on hand, cost it correctly, and reconcile the system to reality._

## The problem

A wholesale distributor's stock lives in three places at once and none of them agree: a
spreadsheet somebody updates when they remember, the physical shelves in the warehouse, and the
delivery van. Nobody can answer "how many do we actually have" without walking to the racking, so
bestsellers stock out while slow movers quietly absorb the company's cash. Goods arrive from
suppliers in cases and go out to customers in singles, so the unit gets confused on almost every
receipt, and because nobody records what each unit actually cost, gross margin is a guess until
the accountant closes the year. Physical counts are a Sunday-with-a-clipboard exercise: the
numbers get typed in weeks later, variances are never explained, and everyone quietly agrees not
to look too closely.

## Why it matters to a tenant

One on-hand number, visible on the web dashboard and on a phone in the aisle, that moves the
moment goods are received or a stock count is committed. Every receipt is costed automatically
(weighted average, four decimal places) so the Inventory page can show a live stock-at-cost figure
instead of a year-end surprise, and boxes-vs-pieces is normalised once, server-side, on every stock
write, so an operator thinking in cases cannot silently under-receive by a factor of the pack size.
Physical counts run off the phone camera: scan, autosave, pause, resume on another device, and
commit with the money variance calculated for you. Buyers who hit an out-of-stock tile can
subscribe to a back-in-stock push that fires exactly once on the next restock, turning a lost order
into a recovered one.

## Core use cases

1. **Know what is on hand, right now** — any operator, on web or phone, can see the current
   quantity, the pack size, the unit cost and the extended value for every product in the
   catalogue, without asking anyone or walking to the racking.
2. **Bring goods in and cost them** — receive stock against a purchase order, against a supplier
   bill, or as a one-off quick restock — so that on-hand and the weighted-average unit cost both
   move in the same transaction, with the receipt written to a movement ledger.
3. **Reconcile the system to reality** — correct the book quantity when it drifts: an ad-hoc
   adjustment for a single product, or a full resumable physical count that snapshots the expected
   quantity, records what was actually found, prices the variance and commits it as auditable
   movements.

## Must have (P0)

| ID      | Capability                                          | Status     | What it does                                                                                                                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | --------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INV-M1  | Live on-hand quantity per product                   | SHIPPED ✅ | Every product carries a current quantity in base units (pieces), readable on web and mobile alongside pack size, unit cost and extended value.   | `GET /api/v1/inventory/overview` → `inventory.service.ts` `getStockOverview` (~:95); `Product.currentStock` Decimal(10,3) (schema.prisma ~:970); web `inventory/page.tsx` `StockTable`; mobile `useStockOverview`.                                                                                                                                                                                                                                                                                                   |
| INV-M2  | Append-only stock movement ledger                   | BROKEN 🔴  | Every quantity change should write a `StockMovement` row carrying type, signed quantity, unit cost and resulting on-hand/average-cost snapshots. | The sale path writes none (`orders.service.ts` ~:1900/:3867, comment "No StockMovement rows"); `recordSale` has zero production callers; `MovementType.WRITE_OFF` has no writer. verified: also NOT append-only — `returns.service.ts:423` and `vendor-bills.service.ts:969` hard-delete movement rows on cancel/void, defeating the audit-trail framing independently of the missing SALE writer.                                                                                                                   |
| INV-M3  | Receive against a purchase order                    | PARTIAL 🟡 | Raise a PO, send it, then receive what arrived — partially or in full — moving stock, cost and PO status together.                               | `POST /inventory/purchase-orders`, `/:id/send`, `/:id/receive`, `/:id/close` (inventory.controller.ts :171-203); `receivePurchaseOrder` (~:1119). No DTO validation on create/receive (`@Body() dto: any`); no idempotency key. verified: understated further — `dto.items` iterated unguarded at ~:1129 with no null check, so a body missing `items` throws inside the transaction and surfaces as a 500, not a 400. Also, "sends" a PO only flips status DRAFT→SENT — no email/PDF actually reaches the supplier. |
| INV-M4  | Quick restock (ad-hoc costed receipt)               | SHIPPED ✅ | Receive goods that arrived without a PO — a van pickup or cash-and-carry run — capturing quantity, cost, and optionally supplier and reference.  | `POST /inventory/movements/purchase` → `recordPurchase` (~:167); `record-purchase.dto.ts`; web `QuickRestockModal`; mobile `useRecordPurchase`; e2e OP-18b.                                                                                                                                                                                                                                                                                                                                                          |
| INV-M5  | Manual stock adjustment                             | PARTIAL 🟡 | Correct a single product's quantity up or down with a note.                                                                                      | `POST /inventory/movements/adjustment` → `recordAdjustment` (~:272). Free-text notes only, no reason code; negative adjustments never draw down `StockLot.remainingQty`; `stockAfter` stamped from a pre-transaction read.                                                                                                                                                                                                                                                                                           |
| INV-M6  | Resumable physical stock count                      | SHIPPED ✅ | Start a count, record what is found (typed or scanned), pause, resume on another device, review the money variance, commit or discard.           | `POST                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | GET /inventory/stock-counts`, `/:id`, `/commit`, `/discard`, `PUT .../lines`(inventory.controller.ts :86-128);`StockCountSession`/`StockCountLine`(schema.prisma :4038/:4076);`applyStockCountItemsInTx`(~:820). verified: the count-entry UI citation was wrong — the actual entry surface is`apps/web/components/inventory/StockCountTab.tsx`(+`StockCountRow.tsx`, `StockCountBulkBar.tsx`, `StockCountReviewModal.tsx`) reached via `?tab=count`; `stock-counts/page.tsx`and`[id]/page.tsx` are the read-only history views. |
| INV-M7  | Inventory valuation at cost                         | SHIPPED ✅ | A single figure for what stock on the shelves is worth, plus a list of products with no cost basis.                                              | `GET /inventory/valuation` → `getValuation` (~~:1326) using `effectiveValue` (~~:76) and `roundMoney`; web Stock Value KPI card; mobile `useInventoryValuation`.                                                                                                                                                                                                                                                                                                                                                     |
| INV-M8  | Set and repair cost basis                           | SHIPPED ✅ | Set a product's cost by hand (single or bulk) and replay movement history to rebuild average costs after a backdated entry or import.            | `PATCH /inventory/products/:id/cost-basis`, `POST /inventory/cost-basis/bulk`, `POST /inventory/recompute-costs` (inventory.controller.ts :136-153); `setCostBasis`/`bulkSetCostBasis`/`recomputeCosts`.                                                                                                                                                                                                                                                                                                             |
| INV-M9  | Boxes-and-pieces normalisation on every stock write | SHIPPED ✅ | Suppliers ship cases, customers buy singles; every stock write accepts a boxes+pieces split and resolves it to base units server-side.           | `normalizeBoxesPieces` in `apps/api/src/common/pricing.ts` (mirrored on web/mobile); boxes/pieces on `RecordPurchaseDto`, `UpsertStockCountLineDto`, `VariantAssignDto`; `receivePurchaseOrder` explicit-boxed branch.                                                                                                                                                                                                                                                                                               |
| INV-M10 | Readable movement history                           | PARTIAL 🟡 | A filterable, paged history of everything that moved a product's stock.                                                                          | `GET /inventory/movements` → `listMovements` (~:131). No supplier/reference filter, no `@Max` on limit, and the largest movement class (sales) is absent entirely (see INV-M2).                                                                                                                                                                                                                                                                                                                                      |
| INV-M11 | Tenant isolation on every stock read and write      | SHIPPED ✅ | One tenant's stock, movements, lots, counts, suppliers and POs are invisible and unwritable from another tenant's session.                       | `forTenant()`/`tenantTransaction()` used throughout `inventory.service.ts`; tenantId columns + indexes on all inventory models.                                                                                                                                                                                                                                                                                                                                                                                      |
| INV-M12 | Oversell guard at order entry                       | PARTIAL 🟡 | A buyer cannot order more than is on hand; staff can deliberately oversell and the negative shows up for reconciliation.                         | `orders.service.ts` ~:1860-1900 — `FOR UPDATE` lock, `ConflictException` for non-staff, logged negative write for staff. Hardcoded policy, no tenant setting, skips DRAFT orders, decrement writes no movement.                                                                                                                                                                                                                                                                                                      |
| INV-M13 | Supplier master (full CRUD)                         | SHIPPED ✅ | A dedicated supplier module — list, get, create, update, deactivate, delete — that every PO, vendor bill and stock movement points to.           | `apps/api/src/suppliers/suppliers.controller.ts` (`GET/POST/PATCH/DELETE /suppliers`, delete nulls `StockMovement.supplierId` rather than orphaning the ledger); mirrored on `InventoryController` (`/inventory/suppliers`, :155-168); web Suppliers tab + `CreateSupplierModal`; mobile `(operator)/suppliers/*`. Added per verification.missedCapabilities.                                                                                                                                                        |
| INV-M14 | Barcode resolution for stock work                   | SHIPPED ✅ | Scan-to-find and scan-to-create ladder for the everyday aisle lookup: barcode → SKU → name search → prompt to create.                            | `GET /api/v1/products/barcode/:barcode` (products.controller.ts :51) backed by `scan-search.ts` `buildScanSearchOr`; mobile `barcode-resolve.ts` + `barcode-normalize.ts`; `products/scan.tsx` routes an unknown code into product creation with the barcode prefilled. Added per verification.missedCapabilities.                                                                                                                                                                                                   |

### Testing criteria

#### INV-M1

- [ ] Given a product with currentStock 12 and averageCost 2.50, `GET /inventory/overview` returns currentStock 12 and totalValue 30 for that row (`Jest, api`).
- [ ] Given a product with both averageCost and standardCost null, the overview row returns averageCost null and totalValue null — never 0 (`Jest, api`).
- [ ] Given tenant A and tenant B each own a product, an operator token for tenant A sees only tenant A's rows (`Jest, api`).
- [ ] Given a tenant with zero products, the web Stock tab renders an empty state, not a spinner or crash (`Playwright e2e, web`).
- [ ] Given unitsPerBox 24 and currentStock 50, the web row shows the piece count plus "(2 boxes + 2 pcs)" (`Playwright e2e, web`).

#### INV-M2

- [ ] INVARIANT: Σ(StockMovement.quantity) must equal Product.currentStock for any product; confirming an order for 10 units currently breaks this by 10 (`Jest, api`; also `scripts/data-integrity-report.mjs`).
- [ ] Given a confirmed order for 10 units, exactly one SALE movement of quantity -10 with a non-null unitCost is created (`Jest, api`).
- [ ] Given the order edited from 10 down to 4 with none delivered, a compensating +6 movement exists (`Jest, api`).
- [ ] Given a product with no movements, `GET /inventory/movements?productId=…` returns an empty array with meta.total 0, not a 500 (`Jest, api`).
- [ ] A cancelled return or voided vendor bill must NOT hard-delete its movement rows — assert the rows persist with a reversing entry instead (`Jest, api` — regression against the `deleteMany` calls in `returns.service.ts:423` and `vendor-bills.service.ts:969`).

#### INV-M3

- [ ] Given a PO line ordered 100 with 0 received, receiving 40 sets qtyReceived 40, status PARTIAL, one PURCHASE movement of +40, one StockLot of 40 (`Jest, api`).
- [ ] Given that line, receiving 70 more (over the 60 outstanding) is rejected 400 and writes nothing (`Jest, api`).
- [ ] Given a CLOSED PO, receiving returns 400 (`Jest, api`).
- [ ] Given a receive body missing `items`, the request returns 400, not a 500 from an unguarded iteration (`Jest, api`).
- [ ] Given a boxed product (unitsPerBox 12), receiving `{boxes: 3, pieces: 2}` increments currentStock by 38 pieces, not 3 (`Jest, api`).
- [ ] MONEY INVARIANT: the movement's unitCost equals the stored `PurchaseOrderItem.unitCost`, never a value from the receive payload (`Jest, api`).

#### INV-M4

- [ ] Given a product at 10 units with averageCost 2.00, restocking 10 at unitCost 3.00 leaves currentStock 20 and averageCost 2.50 (`Jest, api`).
- [ ] Given unitsPerBox 24, posting `{boxes: 2, unitCost: 48}` increments stock by 48 pieces at a per-piece cost of 2.00 (`Jest, api`).
- [ ] Given unitCost 0 or negative, the request is rejected 400 and nothing is written (`Jest, api`).
- [ ] Given the web Quick Restock modal, submitting issues `POST /inventory/movements/purchase` and closes the modal (`Playwright e2e, web` — OP-18b).

#### INV-M5

- [ ] Given a product at 50, adjusting -3 leaves currentStock 47 and writes one ADJUSTMENT movement with stockAfter 47 (`Jest, api`).
- [ ] Given quantity 0, the request is rejected 400 (`Jest, api`).
- [ ] INVARIANT (currently failing): after a -3 adjustment, Σ(StockLot.remainingQty) must still equal currentStock (`Jest, api`).
- [ ] Given two concurrent -1 adjustments against a product at 10, both movements' stockAfter snapshots must be distinct (9 and 8), not both 9 (`Jest, api`).

#### INV-M6

- [ ] Given an OPEN session with a line counted 8 against expected 10, committing writes one ADJUSTMENT of -2 referenced `STOCK_COUNT-<sessionId>` and flips the session to COMMITTED (`Jest, api`).
- [ ] IDEMPOTENCY: re-posting `/commit` returns `{alreadyCommitted: true}` and applies no second delta (`Jest, api`).
- [ ] Products with no counted line are never touched (`Jest, api`).
- [ ] Given a boxed product entered as `{boxes: 2, pieces: 3}` with unitsPerBox 12, countedQty resolves to 27 (`Jest, api`).
- [ ] Given a session started on web via the `StockCountTab` entry flow, opening the same session id on mobile shows the already-counted lines (`manual / Playwright e2e`).

#### INV-M7

- [ ] MONEY INVARIANT: totalValue is rounded to cents and equals Σ over active products of currentStock × effective unit cost (`Jest, api`).
- [ ] Given a product with null averageCost AND null standardCost, it is excluded from totalValue and appears in missingCostProducts (`Jest, api`).
- [ ] Given an inactive product with stock, it is excluded from valuation (`Jest, api`).

#### INV-M8

- [ ] Setting cost basis writes a COST_BASIS movement of quantity 0 and updates Product.averageCost (`Jest, api`).
- [ ] `recomputeCosts` with dryRun true reports would-be corrections and writes nothing (`Jest, api`).
- [ ] A cost above the Decimal(10,4) bound is rejected 400, not a Prisma 500 (`Jest, api`).

#### INV-M9

- [ ] INVARIANT: for unitsPerBox 12, `{boxes: 2, pieces: 15}` normalises with rollover to 39 pieces (`Jest, api` — pricing.spec.ts).
- [ ] Sending boxes/pieces for a product with unitsPerBox ≤ 1 is rejected 400, never silently resolves to 0 (`Jest, api`).
- [ ] Given unitsPerBox 24 and currentStock 50, the web row shows "2 boxes + 2 pcs"; a non-finite value shows an em dash, never NaN (`Playwright e2e, web`).

#### INV-M10

- [ ] Given movements of several types, `?type=ADJUSTMENT` returns only adjustments (`Jest, api`).
- [ ] Given `?limit=100000`, the response is capped rather than returning the whole table (`Jest, api` — currently unenforced).
- [ ] A movement written by another tenant never appears for this tenant regardless of productId supplied (`Jest, api`).

#### INV-M11

- [ ] Given tenant A's product id, an operator token for tenant B calling PATCH cost-basis returns 404 and writes nothing (`Jest, api`).
- [ ] Every StockCountLine created through PUT lines carries a non-null tenantId equal to the session's tenant (`Jest, api`).
- [ ] No inventory write path calls `this.prisma.<model>` directly instead of `forTenant()`/`tenantTransaction()` (static scan).

#### INV-M12

- [ ] Given a product at 5 on hand, a CUSTOMER-role order for 6 is rejected 409 and not persisted (`Jest, api`).
- [ ] Given the same state, an OPERATOR-role order for 6 succeeds and leaves currentStock at -1 with a warning logged (`Jest, api`).
- [ ] Given two concurrent orders each for 3 against a product at 5, exactly one is rejected (`Jest, api` / integration).

#### INV-M13

- [ ] Deleting a supplier that has stock movements nulls `supplierId` on those movements rather than orphaning or blocking the delete (`Jest, api`).
- [ ] Creating a PO for a nonexistent supplier id is rejected 400 (`Jest, api`).
- [ ] The web Suppliers tab and mobile supplier list both round-trip create/edit/deactivate (`Playwright e2e, web` / manual mobile).

#### INV-M14

- [ ] Scanning a known barcode resolves directly to its product (`Jest, api`).
- [ ] Scanning an unrecognised barcode on mobile routes into product creation with the barcode prefilled, not a dead end (`manual on device`).
- [ ] Barcode search is tenant-scoped — another tenant's matching barcode never resolves (`Jest, api`).

## Nice to have (P1)

| ID      | Capability                                         | Status            | What it does                                                                                                                                                                                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | -------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INV-N1  | Low-stock list and dashboard KPI                   | BROKEN 🔴         | A count and short list of products running out.                                                                                                                                                                         | `LowStockPanel`/KPI call `stockStatus:'LOW'`; server hardcodes `currentStock <= 5`, ignoring `Product.reorderPoint`; the panel reads a `lowStockThreshold` column that does not exist on the model. Open defect B25.                                                                                                                                                                                                                                                                                                                                             |
| INV-N2  | Per-product reorder point and reorder quantity     | PARTIAL 🟡        | Set the level at which a product should be re-bought and how much to buy.                                                                                                                                               | `Product.reorderPoint`/`reorderQty`; only writer is `PATCH /inventory/products/:productId/reorder-settings`, gated by `flag.forecasting`, takes `@Body() dto: any`; never consumed by the low-stock filter.                                                                                                                                                                                                                                                                                                                                                      |
| INV-N3  | Demand forecasting / days of cover                 | PARTIAL 🟡        | Average daily sales, days of stock remaining, below-reorder-point flag per product.                                                                                                                                     | `GET /inventory/forecasting` → `getForecasting` (~:1279), gated `flag.forecasting`. The Forecasting tab renders unconditionally on web with no flag check anywhere in `apps/web`, so an un-entitled tenant gets a 403 panel.                                                                                                                                                                                                                                                                                                                                     |
| INV-N4  | Buyer back-in-stock alerts (Notify me)             | SHIPPED ✅        | A buyer on an out-of-stock product subscribes; the next restock sends exactly one push and clears the subscription.                                                                                                     | `stock-alert.service.ts` (subscribe/unsubscribe/fireForProducts); `StockAlert` with `@@unique(tenantId,customerId,productId)`; fire hooks after every restock path.                                                                                                                                                                                                                                                                                                                                                                                              |
| INV-N5  | Scan-driven counting on the phone                  | SHIPPED ✅        | Point the camera at a barcode and the count increments; undo, adjustable qty-per-scan, unknown-barcode options.                                                                                                         | `stock-count/[id].tsx` — `BarcodeFab`, `undoLastScan`, `showUnknownBarcodeOptions`; autosave engine `stock-count-autosave.ts`, unit-tested.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| INV-N6  | Purchase order lifecycle                           | BROKEN 🔴         | Draft a PO, send it, receive partially or fully, close it.                                                                                                                                                              | verified: mobile types `POStatus` with `"PARTIALLY_RECEIVED"`, which the server's `PurchaseOrderStatus` enum (DRAFT/SENT/PARTIAL/RECEIVED/CLOSED) rejects 400 on the list query; worse, the mobile Receive button is gated on status `SENT` or `PARTIALLY_RECEIVED`, so once a PO flips to `PARTIAL` the Receive action disappears permanently on mobile — a partially-received PO can never be finished from the phone.                                                                                                                                         |
| INV-N7  | Receive stock from a supplier bill                 | SHIPPED ✅        | Marking a supplier's invoice received brings goods onto stock at the bill's line cost.                                                                                                                                  | `vendor-bills.service.ts` `receive()` — stock increment + PURCHASE movement + STANDARD-cost guard; reversals decrement; duplicate-invoice 409 guard.                                                                                                                                                                                                                                                                                                                                                                                                             |
| INV-N8  | Split a generic product's stock into variants      | SHIPPED ✅        | Apportion generically-received stock to real variants in one atomic move.                                                                                                                                               | `POST /inventory/variant-assign` → `assignToVariants` (~:422) inside a Serializable transaction; spec `variant-assign.spec.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| INV-N9  | Stock-count history with a money variance headline | SHIPPED ✅        | Every committed or discarded count stays on file with its worth, server-computed.                                                                                                                                       | `listStockCountSessions` computes `netVarianceMoney` server-side (~:1551); payload omits raw lines.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| INV-N10 | Amend a committed count                            | SHIPPED ✅        | A count committed with a mistake can be amended without rewriting history.                                                                                                                                              | `StockCountSession.amendsSessionId` + amend branch (~:1474); web deep link `?tab=count&amend=<id>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| INV-N11 | Dead-stock report                                  | PARTIAL 🟡        | Which products have no sales activity in a window, and what that idle stock is worth.                                                                                                                                   | `GET /analytics/inventory/dead-stock`. verified: `AnalyticsController` applies `PlanFlagGuard` + `@RequirePlanFlag('flag.analytics')` at CLASS level, so this 403s for any tenant without the addon (same FORECASTING SKU as INV-N3) — and `analytics/page.tsx` calls it unconditionally with no plan-flag hook anywhere on web.                                                                                                                                                                                                                                 |
| INV-N12 | Inventory turnover and margin alerts               | PARTIAL 🟡        | How fast stock converts to sales; products selling at or below cost.                                                                                                                                                    | `GET /analytics/inventory/turnover`, `/margin-alerts`. verified: same class-level `flag.analytics` gate as INV-N11, consumed unconditionally by web and mobile — addon-conditional, not universally available as originally stated.                                                                                                                                                                                                                                                                                                                              |
| INV-N13 | Returns put stock back                             | PARTIAL 🟡        | Receiving a customer return increases sellable stock at current average cost.                                                                                                                                           | `returns.service.ts` `receive()` writes a RETURN movement and increments stock. verified: B69 (cancel/receive race) is FIXED — both `→RECEIVED` and `→CANCELLED` transitions use an in-transaction CAS (`updateMany` guarded on status) that aborts the loser (~:244-250, ~:406-412). A real, shipped `restock:false` control also exists per return line (`receive-return.dto.ts`, `returns.controller.ts:81`) — B61 (damaged/expired goods restocking) is narrower than stated: the lever exists, it's just not auto-derived from the driver's condition code. |
| INV-N14 | Regulated-stock scoping on the inventory view      | SHIPPED ✅        | Tenants handling age-restricted or excise goods view/count that stock separately.                                                                                                                                       | `Product.trackedCategoryId`/`trackedSubcategoryId`; web `RegulatedScopeTabs`; gated by `addon.regulated_items`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| INV-N15 | Export stock and movement data                     | MISSING ⬜        | Pull the stock list or movement history into a spreadsheet.                                                                                                                                                             | No export control anywhere in the inventory area; no CSV route on `InventoryController`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| INV-N16 | Mobile Warehouse hub                               | NICE — SHIPPED ✅ | A dedicated operator tab: low/out-of-stock counts, stock valuation with quick "set missing costs"/"recompute costs" actions, SKUs tracked, regulated section, and quick links to Movements/Adjust/Count/Buy stock/Scan. | `apps/mobile/app/(operator)/(tabs)/warehouse.tsx` — the mobile equivalent of the whole web Inventory page. Added per verification.missedCapabilities.                                                                                                                                                                                                                                                                                                                                                                                                            |
| INV-N17 | Tenant cost & margin configuration                 | NICE — SHIPPED ✅ | Set the tenant's default costing method and per-category margin floors; this is also what sets the default costing method for newly created products.                                                                   | `GET/PATCH /api/v1/settings/margin` → `system-config.service.ts` (`costing.method`, `margin.floor.default`, per-category floors); web `apps/web/lib/api/margin.ts`, settings page. Added per verification.missedCapabilities.                                                                                                                                                                                                                                                                                                                                    |
| INV-N18 | Opening-balance / closing-stock import             | NICE — SHIPPED ✅ | A migration-time stock load that sets Product.currentStock from an imported figure AND writes the delta as a StockMovement.                                                                                             | `import.service.ts` ~:1436-1523; also `POST /products/import` writes currentStock/averageCost per row. Added per verification.missedCapabilities.                                                                                                                                                                                                                                                                                                                                                                                                                |
| INV-N19 | Per-product cost history and demand analytics      | NICE — SHIPPED ✅ | Per-product view of average-cost drift over time, and per-product demand as an input to reorder decisions.                                                                                                              | `GET /analytics/cost-history/:productId`, `GET /analytics/demand/:productId` (analytics.controller.ts :36-39); e2e `11-product-demand.spec.ts`. Added per verification.missedCapabilities.                                                                                                                                                                                                                                                                                                                                                                       |
| INV-N20 | Pack-size capture prompt                           | NICE — SHIPPED ✅ | The UI flow that actually gets `unitsPerBox` onto a product — without it, every boxed affordance silently degrades to pieces.                                                                                           | `apps/web/components/PackSizePrompt.tsx`, e2e `14-pack-size-prompt.spec.ts`; capture also in `ProductCreateModal.tsx`/`InlineCreateProductModal.tsx`. Added per verification.missedCapabilities.                                                                                                                                                                                                                                                                                                                                                                 |

### Testing criteria

#### INV-N1

- [ ] Given reorderPoint 40 and currentStock 30, the product MUST appear under stockStatus=LOW — today it does not (`Jest, api`).
- [ ] Given reorderPoint 2 and currentStock 4, it must NOT be flagged low — today it is (`Jest, api`).
- [ ] The dashboard KPI count and the low-stock list must describe the same set of products (`Playwright e2e, web`).

#### INV-N2

- [ ] Setting reorderPoint 40 / reorderQty 120 persists both and is returned by the overview (`Jest, api`).
- [ ] A negative or non-integer reorderPoint is rejected 400 (`Jest, api`).

#### INV-N3

- [ ] Given zero sales in the window, daysRemaining is null, not Infinity or 0 (`Jest, api` + `Playwright e2e`).
- [ ] Given a tenant WITHOUT `flag.forecasting`, the Forecasting tab is not rendered at all — today it renders and 403s (`Playwright e2e, web`).

#### INV-N4

- [ ] Subscribing twice leaves exactly one StockAlert row in PENDING (`Jest, api`).
- [ ] A restock that leaves on-hand at 0 or negative fires nothing (`Jest, api`).
- [ ] A buyer of tenant A never receives an alert for a tenant B product with the same id (`Jest, api`).

#### INV-N5

- [ ] Three scans of the same barcode within the debounce window coalesce into ONE PUT with delta 3 (`Jest, mobile`).
- [ ] An unrecognised barcode surfaces an options action, never a silent no-op (`manual on device`).

#### INV-N6

- [ ] Mobile's PO status query must send a value inside the server's `PurchaseOrderStatus` enum — `PARTIALLY_RECEIVED` is not a member and 400s (`Jest, mobile` — pinned by `list-purchase-orders.dto.spec.ts:56-58`).
- [ ] Once a PO is `PARTIAL`, the mobile Receive action must remain reachable — today it disappears permanently because the gate excludes `PARTIAL` (`manual on device` / `Jest, mobile`).
- [ ] Two POs created concurrently receive distinct poNumbers (`Jest, api`).
- [ ] Closing a PARTIAL PO sets status CLOSED and blocks any further receive with 400 (`Jest, api`).

#### INV-N7

- [ ] Receiving a bill line for 24 units at 1.50 increments stock by 24 and moves averageCost by weighted average (`Jest, api`).
- [ ] Voiding a received bill decrements exactly what it added, without deleting the original movement rows (`Jest, api`).
- [ ] A duplicate supplier invoice number for the same supplier is refused 409 before any stock moves (`Jest, api`).

#### INV-N8

- [ ] INVARIANT: after a split, the parent's decrease equals the sum of the variants' increases exactly (`Jest, api`).
- [ ] Assigning more than the parent's currentStock returns 400 and writes nothing (`Jest, api`).
- [ ] Two concurrent splits of the same generic cannot both succeed past the pool check (`Jest, api`).

#### INV-N9

- [ ] MONEY INVARIANT: netVarianceMoney equals Σ over lines of (countedQty − expectedQty) × effective unit cost, rounded to cents (`Jest, api`).
- [ ] The list payload contains no `lines` array (`Jest, api`).

#### INV-N10

- [ ] Amending a COMMITTED session creates a NEW session with `amendsSessionId` set and leaves the original untouched (`Jest, api`).
- [ ] Amending a DISCARDED or still-OPEN session is refused (`Jest, api`).

#### INV-N11

- [ ] A tenant WITHOUT `flag.analytics` gets a hidden control, not a 403 panel, for dead-stock (`Playwright e2e, web` — currently ungated on web despite server gate).
- [ ] A product with stock and an invoice inside the window is excluded; the same product with its last invoice before the window is included (`Jest, api`).
- [ ] A product with stock 0 is never listed (`Jest, api`).

#### INV-N12

- [ ] A tenant WITHOUT `flag.analytics` gets a hidden control, not a 403 panel, for turnover/margin-alerts (`Playwright e2e, web`).
- [ ] A product whose selling price is below its effective unit cost appears in margin-alerts; one a cent above does not (`Jest, api`).

#### INV-N13

- [ ] Receiving a return of 4 units writes one RETURN movement of +4 and increments stock by 4 (`Jest, api`).
- [ ] A return line with `restock:false` skips restocking entirely and persists that flag so a later cancel stays symmetric (`Jest, api` — covered by `returns-refund.spec.ts:317`).
- [ ] Concurrent cancel and receive on the same return resolve via the in-transaction CAS — exactly one wins (`Jest, api` — regression against the fixed B69).
- [ ] A return line whose reason is Damaged or Expired is not auto-restocked unless the operator explicitly sets restock true (`Jest, api` — open gap, B61 narrowed).

#### INV-N14

- [ ] A tenant with no regulated sections sees no scope tabs at all (`Playwright e2e, web`).
- [ ] A product cannot be given a trackedCategoryId without the regulated addon (`Jest, api`).

#### INV-N15

- [ ] Exporting the stock list produces a file whose row count equals the filtered on-screen list (`Playwright e2e, web`).

#### INV-N16

- [ ] The Warehouse hub's low/out-of-stock counts match the same numbers shown on the web dashboard KPI (`manual / Playwright e2e`).
- [ ] "Set N missing costs" routes to bulk-set-cost with the correct product set preselected (`manual on device`).

#### INV-N17

- [ ] Changing `costing.method` via settings changes the costing method applied to newly created products (`Jest, api` — `products.service.spec.ts:423`).
- [ ] A margin floor set per category is honoured by `MarginHint` on the relevant product forms (`manual / Playwright e2e`).

#### INV-N18

- [ ] Importing a closing-stock figure that differs from the current value writes a StockMovement for the delta (`Jest, api`).
- [ ] Importing a closing-stock figure equal to the current value writes no movement (`Jest, api`).

#### INV-N19

- [ ] Cost-history for a product reflects every COST_BASIS and PURCHASE movement in chronological order (`Jest, api`).
- [ ] Demand-by-product respects the same tobacco-exclusion exemption documented in code (`Jest, api`).

#### INV-N20

- [ ] Creating a product without setting unitsPerBox prompts for pack size before the product can be saved with boxed pricing (`Playwright e2e, web` — `14-pack-size-prompt.spec.ts`).

## Advanced / future (P2)

| ID      | Capability                                          | Status                | What it does                                                                                                                 | Evidence                                                                                                                                                                                                                                                                                           |
| ------- | --------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INV-A1  | Multi-warehouse / multi-location stock              | MISSING ⬜            | Track the same product across multiple locations with transfers and per-location on-hand.                                    | No Warehouse/Location model; `StockMovement`/`StockLot` carry no locationId; `Product.currentStock` is a single scalar.                                                                                                                                                                            |
| INV-A2  | Batch/lot numbers with expiry and FEFO picking      | MISSING ⬜            | Record supplier lot number and best-before date on receipt; pick first-expiring-first; near-expiry warnings; recall support. | `StockLot` has qty/remainingQty/unitCost/reference/notes only — no lotNumber, no expiryDate anywhere in the schema.                                                                                                                                                                                |
| INV-A3  | True FIFO / LIFO / last-cost COGS on sale           | BROKEN 🔴             | Cost each sale by the tenant's chosen method and draw the matching lots down.                                                | `CostingMethod` enum and `recordSale`'s lot-consumption logic exist but have zero production callers; valuation was changed to weighted-average for every method, so the label affects no number.                                                                                                  |
| INV-A4  | Automatic replenishment suggestions and PO drafting | MISSING ⬜            | Turn "below reorder point" into a draft PO per supplier, sized by quantity and lead time.                                    | `needsReorder` is computed by `getForecasting` but nothing drafts a PO from it; `Supplier.leadTimeDays` exists with no reader.                                                                                                                                                                     |
| INV-A5  | Stock reservation and available-to-promise          | MISSING ⬜            | Distinguish physical on-hand from what is promised to open orders; release on cancel.                                        | No reservation model; stock is deducted at order creation instead, which is why cancelling never returns it (B64) and reopening a delivered stop overstates it (B55).                                                                                                                              |
| INV-A6  | Shrinkage, write-offs and reason-coded adjustments  | MISSING ⬜            | Classify every stock loss so shrinkage can be reported as a percentage of sales.                                             | `MovementType.WRITE_OFF` exists in the enum with no writer anywhere; `RecordAdjustmentDto` carries free-text notes only.                                                                                                                                                                           |
| INV-A7  | Landed cost allocation                              | MISSING ⬜            | Spread freight/duty/clearance across receipt lines so unit cost reflects true landed cost.                                   | `receivePurchaseOrder` and the vendor-bill receive path pin cost to the stored per-piece unit cost only; no freight/duty field on the PO model.                                                                                                                                                    |
| INV-A8  | Point-in-time (as-of) stock and valuation report    | PARTIAL 🟡            | Answer "what did we hold, and what was it worth, on a given date."                                                           | Every movement stamps `avgCostAfter`/`stockAfter` (the raw material exists), but there is no as-of endpoint, and snapshots are unreliable for any product whose stock moved via the order path (see INV-M2).                                                                                       |
| INV-A9  | Offline-durable warehouse counting                  | PARTIAL 🟡            | Count a cold store or back racking with no signal and lose nothing on app restart.                                           | Server session is resumable across devices, but the mobile pending-scan queue is in-memory only — no device-storage persistence, no connectivity listener.                                                                                                                                         |
| INV-A10 | Serial-number tracking                              | MISSING ⬜            | Track individually serialised goods from receipt to the customer they went to.                                               | No serial field on Product, StockLot, StockMovement, OrderItem or InvoiceItem.                                                                                                                                                                                                                     |
| INV-A11 | Inventory-to-ledger posting (COGS and stock asset)  | BROKEN 🔴             | Every stock movement books to the right account so the P&L shows real gross margin.                                          | `getProfitAndLoss` sources COGS from SALE movements, which the order path never writes — reported COGS is 0 and gross profit equals revenue.                                                                                                                                                       |
| INV-A12 | Production stock-integrity forensics (read-only)    | ADVANCED — SHIPPED ✅ | Read-only production checks for negative stock and stock-vs-last-movement drift, run under a forced read-only session.       | `scripts/data-integrity-report.mjs` — `product-negative-stock` (:360-366) and `stock-vs-last-movement` (:369-384); the latter is recorded REFUTED in the script's own header because the ledger cannot reconstruct currentStock by design given INV-M2. Added per verification.missedCapabilities. |

### Testing criteria

#### INV-A1

- [ ] Receiving 100 into Depot A and 50 into Depot B yields per-location on-hand of 100 and 50, total 150 (`Jest, api`).
- [ ] A transfer of 20 from A to B leaves the total unchanged (`Jest, api` — INVARIANT).

#### INV-A2

- [ ] Receiving two lots with different expiry dates then picking consumes the earlier-expiring lot first (`Jest, api`).
- [ ] Given a recalled lot number, the system lists every invoice that received units from that lot (`Jest, api`).

#### INV-A3

- [ ] INVARIANT: Σ(StockLot.remainingQty) equals Product.currentStock — currently false by construction (`Jest, api`).
- [ ] A FIFO product bought at 2.00 then 3.00 and sold 1 unit books COGS of 2.00 and draws the older lot down (`Jest, api`).

#### INV-A4

- [ ] Given three products below reorder point from two suppliers, the suggestion produces two draft POs grouped by supplier (`Jest, api`).
- [ ] Generating suggestions twice in a row does not create duplicate drafts (`Jest, api`).

#### INV-A5

- [ ] INVARIANT: physical on-hand = free-to-sell + reserved, at all times (`Jest, api`).
- [ ] Cancelling an order releases its reservation and free-to-sell returns to its pre-order value (`Jest, api`).

#### INV-A6

- [ ] An adjustment must carry a reason from a closed list; free-text-only is rejected 400 (`Jest, api`).
- [ ] Write-offs reduce inventory value and appear as an expense in the P&L (`Jest, api` — MONEY INVARIANT).

#### INV-A7

- [ ] MONEY INVARIANT: freight of 120 allocated across a 3-line receipt raises Σ(qty × new unit cost) by exactly 120, rounded to cents (`Jest, api`).
- [ ] Landed cost never touches a STANDARD-costed product's averageCost (`Jest, api`).

#### INV-A8

- [ ] Given movements on 1, 10 and 20 August, an as-of report for 15 August reports the 10 August stockAfter/avgCostAfter (`Jest, api`).
- [ ] MONEY INVARIANT: an as-of report for today equals the live valuation to the cent (`Jest, api`).

#### INV-A9

- [ ] Scans queued while offline are persisted to device storage and flushed on the next successful connection (`Jest, mobile`).
- [ ] Force-quitting the app with 12 unflushed scans and reopening replays all 12 exactly once (`manual on device`).

#### INV-A10

- [ ] Receiving 3 serialised units requires 3 distinct serials and rejects a duplicate 409 (`Jest, api`).
- [ ] Searching a serial returns the receipt, the sale and the current holder (`Jest, api`).

#### INV-A11

- [ ] MONEY INVARIANT: COGS reported in the P&L equals Σ(|SALE movement quantity| × its unitCost), rounded to cents — today returns 0 (`Jest, api`).
- [ ] Gross profit is strictly less than revenue for any tenant that has sold costed stock (`Jest, api`).

#### INV-A12

- [ ] `product-negative-stock` flags any product with currentStock < -0.001 (`manual` — read-only prod script).
- [ ] `stock-vs-last-movement` results are read as informational only, never as an actionable alert, given its documented REFUTED status (`manual` — read-only prod script).

## How this varies by tenant

| Variation                                                           | Mechanism                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Demand forecasting, days-of-cover, ability to set reorder points    | `flag.forecasting`, enforced by `PlanFlagGuard` on `GET /inventory/forecasting` and the reorder-settings endpoint; granted by the FORECASTING addon SKU, self-serviceable.                                                                                                                                         |
| Dead-stock report, turnover, margin alerts                          | `flag.analytics`, enforced at CLASS level on `AnalyticsController` — the SAME addon SKU as forecasting. verified: this gate was missed by the original analysis for these three endpoints.                                                                                                                         |
| Separate view/count/report scope for age-restricted or excise stock | `tobacco_dealer` legacy addon key → `addon.regulated_items`, drives `Product.trackedCategoryId` and `RegulatedScopeTabs`.                                                                                                                                                                                          |
| Buyers can self-serve a back-in-stock alert                         | `addon.buyer_portal` — StockAlert reachable only through buyer surfaces.                                                                                                                                                                                                                                           |
| Costing method per product (FIFO/LIFO/AVCO/STANDARD/LAST_COST)      | `Product.costingMethod`, editable per product, default AVCO — but since the valuation change the label affects NO number except STANDARD. Presented as configurable, effectively inert.                                                                                                                            |
| **Default costing method for newly created products**               | `costing.method` SystemConfig key, set via `GET/PATCH /settings/margin`, propagated through `resolveCostingMethod`/`TENANT_COSTING_TO_PRODUCT` onto every product created without an explicit method. verified: the original analysis called this **NOT CONFIGURABLE**; it is, and this is the tenant-level lever. |
| Pack size / case quantity per product                               | `Product.unitsPerBox` — set on the product form and the pack-size prompt; gates box-price proration, boxes/pieces inputs, scanning, count denominations and variant splitting.                                                                                                                                     |
| Supplier lead time (would drive safety stock and reorder timing)    | `Supplier.leadTimeDays` column exists — **NOT CONFIGURABLE in effect**: no reader anywhere in the inventory module.                                                                                                                                                                                                |
| What counts as "low stock"                                          | **NOT CONFIGURABLE** — hardcoded `currentStock <= 5` in `products.service.ts` and a `lowStockThreshold` reference to a column that doesn't exist on the model. Per-product `reorderPoint` exists but is ignored by both.                                                                                           |
| Whether stock may go negative (oversell policy)                     | **NOT CONFIGURABLE** — hardcoded by role in `orders.service.ts`: staff oversell with a warning, non-staff get 409.                                                                                                                                                                                                 |
| Who may move stock                                                  | Partly hardcoded by `@Roles` on `InventoryController` — driver can record purchases/adjustments/receive POs; stock counts, cost basis, suppliers, valuation are operator-only. No per-tenant role matrix.                                                                                                          |
| Number of stock locations / warehouses                              | **NOT CONFIGURABLE** — single implicit location; no Warehouse model.                                                                                                                                                                                                                                               |
| Internal low-stock notification to staff                            | `NotificationEvent.LOW_STOCK` is fully configured (channel matrix, seeded template, Settings toggle) but **has no emitter anywhere** — the toggle controls nothing.                                                                                                                                                |

## Gaps for a great UX

| Severity | Gap                                                                                                                                                                                                                                                                                 | Impact                                                                                                                                                                        | Suggested direction                                                                                                                                                                                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRITICAL | On-hand and the movement ledger disagree by design on the single largest stock flow — selling. Orders decrement `currentStock` directly with no `StockMovement`, and cancelled returns / voided bills additionally hard-delete existing movement rows (verified).                   | The ledger cannot explain why stock fell. Reported COGS is 0 and gross profit equals revenue. Lot-based costing and any future FEFO/recall feature has no reliable base.      | Restore a SALE movement writer on the order/fulfilment path, reusing `recordSale`. Stop hard-deleting movements on cancel/void — write a reversing entry instead. Add a Σ(movements)==currentStock Jest invariant and keep it visible in `scripts/data-integrity-report.mjs` (which already tracks this class of drift and marks it REFUTED under current design). |
| CRITICAL | Stock is deducted at order creation rather than reserved; cancelling never gives stock back (B64) while reopening a delivered stop credits stock the delivery never took (B55).                                                                                                     | Every cancellation permanently understates on-hand; every reopen/redeliver cycle permanently overstates it.                                                                   | Introduce a reservation concept (physical on-hand vs. free-to-sell); short of that, fix both asymmetries directly with pinned Jest invariants.                                                                                                                                                                                                                     |
| HIGH     | "Low stock" is a hardcoded quantity of 5 and ignores the per-product `reorderPoint` the model already carries; the dashboard panel reads a `lowStockThreshold` field that does not exist.                                                                                           | A tenant selling 200 cases/week of one line and 3 of another gets the same alert threshold for both — confidently wrong answers.                                              | Make LOW mean `currentStock <= COALESCE(reorderPoint, tenantDefaultThreshold)`; add the tenant default as a real setting; delete the phantom `lowStockThreshold` reads.                                                                                                                                                                                            |
| HIGH     | The Forecasting tab, and the dead-stock/turnover/margin-alerts analytics, are rendered unconditionally on web but gated server-side by `flag.forecasting`/`flag.analytics` (verified — the analytics gate was missed entirely by the original analysis).                            | A tenant without the addon clicks a first-class tab or report and gets an error panel, reading as a broken product rather than a locked feature.                              | Add a plan-flag hook mirroring `useHasAddon`; hide or upsell instead of rendering-then-403ing; assert the hidden case in a Playwright gate spec.                                                                                                                                                                                                                   |
| HIGH     | `createPO`, `receivePO` and `setReorderPoint` take unvalidated `@Body() dto: any`; `receivePurchaseOrder` iterates `dto.items` with no null guard, so a missing `items` key throws inside the transaction and surfaces as a 500 (verified — worse than originally described).       | Malformed or hostile payloads reach Prisma directly; a missing field crashes with a 500 instead of a clean 400.                                                               | Wire the DTOs — verified: `CreatePurchaseOrderDto` AND `ReceivePurchaseOrderDto` are already written in `create-purchase-order.dto.ts:36-50`; this is now a one-line import/wiring change into the controller, not new design work.                                                                                                                                |
| HIGH     | `StockLot.remainingQty` is never drawn down by negative adjustments or by the order path, so Σ(remainingQty) diverges permanently from currentStock.                                                                                                                                | Any lot-derived number — a future FIFO cost, batch recall, expiry report — starts from a corrupted base; previously inflated valuation before valuation was routed around it. | Make every negative stock movement consume lots via `planLotConsumption`; add the Σ(remainingQty)==currentStock invariant to Jest and the integrity report.                                                                                                                                                                                                        |
| MEDIUM   | Adjustments carry free-text notes only, no reason code; `MovementType.WRITE_OFF` has no writer anywhere.                                                                                                                                                                            | Shrinkage is unmeasurable — a tenant losing 2% of stock to damage/theft cannot see it, attribute it, or show an insurer anything.                                             | Add a closed reason list to `RecordAdjustmentDto`, route loss reasons to WRITE_OFF movements, add a shrinkage-by-reason report next to dead-stock and turnover.                                                                                                                                                                                                    |
| MEDIUM   | No batch/lot numbers, no expiry dates, no FEFO.                                                                                                                                                                                                                                     | Any tenant handling date-coded goods cannot use the system for its most safety-critical job — knowing what's about to expire, or answering a recall.                          | Add `lotNumber`/`expiryDate` to `StockLot`, capture on both receive paths, add a near-expiry report, pick earliest-expiry first.                                                                                                                                                                                                                                   |
| MEDIUM   | Concurrency/idempotency holes: `recordAdjustment` stamps `stockAfter` from a pre-transaction read; neither adjustment nor receive carries an idempotency key.                                                                                                                       | Concurrent adjustments produce identical wrong snapshots; a retried receive can double-receive while outstanding quantity still covers it.                                    | Re-read the product inside the transaction before stamping snapshots; accept a client idempotency reference on adjustment and receive.                                                                                                                                                                                                                             |
| MEDIUM   | The internal LOW_STOCK notification is fully configured (channel matrix, template, Settings toggle) but nothing emits it.                                                                                                                                                           | A tenant switches it on expecting to be told when a line runs out, and is told nothing — corrodes trust in every other toggle on the page.                                    | Emit LOW_STOCK when a movement takes on-hand from above to at-or-below the effective threshold, deduped per crossing, or remove the toggle until it does something.                                                                                                                                                                                                |
| MEDIUM   | No export anywhere in the inventory area; the movements list has no server-side limit cap.                                                                                                                                                                                          | Stock-take reconciliation, an auditor's request and accountant hand-off all become copy-paste from the screen; `?limit=100000` can pull the whole movement table.             | Add CSV export honouring the filters actually applied on screen; clamp the movements DTO limit like other list endpoints.                                                                                                                                                                                                                                          |
| MEDIUM   | Mobile stock-count autosave holds unflushed scans in memory only — no device-storage persistence, no connectivity listener.                                                                                                                                                         | The exact scenario the feature exists for — a cold store or back racking with no signal — loses work if the app is backgrounded out of memory.                                | Persist the pending queue to AsyncStorage keyed by session id, replay on mount, drive a flush from a connectivity listener.                                                                                                                                                                                                                                        |
| MEDIUM   | Once a purchase order reaches `PARTIAL` status, mobile's Receive action disappears because the status gate excludes it, and the status query itself sends an enum value the server rejects 400 (verified — corrected from "low-confidence" to a live, worse-than-described defect). | A partially-received PO can never be finished from the phone — the operator has to switch to web mid-receive.                                                                 | Fix the mobile enum to match the server's `PurchaseOrderStatus`; include `PARTIAL` in the Receive-button gate.                                                                                                                                                                                                                                                     |
| MEDIUM   | Drivers can record backdated adjustments and receive POs while stock counts are operator-only; the split is hardcoded (B168).                                                                                                                                                       | The person with the least visibility into the book quantity has the most powerful unreviewed write, including a backdate that triggers a history replay.                      | Move the inventory role matrix behind tenant configuration; strip `effectiveDate` from the driver-reachable adjustment path at minimum.                                                                                                                                                                                                                            |
| LOW      | COST_BASIS rows render as a raw enum code in the web movement history (B28); the movements list offers no supplier or reference filter.                                                                                                                                             | The audit trail an operator reaches for when a number looks wrong reads like a database dump.                                                                                 | Add a label map for movement types; extend the movements DTO with supplierId and reference filters.                                                                                                                                                                                                                                                                |

## Cross-domain handoffs

- **Orders → Inventory** (currently the weakest link): `orders.service.ts` decrements `Product.currentStock`
  directly at create and on line edits under a `FOR UPDATE` lock, writing no `StockMovement`. Any
  change to the reservation or movement model must start here; the operator-oversell allowance
  lives here too.
- **Routes / Deliveries → Inventory**: `routes.service.ts` `reopenStop` writes compensating positive
  SALE movements and increments stock, assuming an original negative SALE the order path never
  wrote (B55).
- **Returns → Inventory**: `returns.service.ts` `receive()` writes a RETURN movement and increments
  stock at current average cost; `refund`/`cancel` decrements, now with an in-transaction CAS
  closing the former race (B69, verified fixed). Cancelled returns hard-delete their own movement
  rows on cancel (verified — see INV-M2 gap).
- **Vendor bills / Purchasing → Inventory**: `vendor-bills.service.ts` `receive()` is the main
  real-world restock path — increments stock, writes a PURCHASE movement, honours the
  STANDARD-cost guard, fires back-in-stock alerts; void and revert-to-draft decrement (and, per
  verification, hard-delete the original movement row on void). Supplier master is shared with AP.
- **Products & catalogue → Inventory**: `Product.unitsPerBox`, `costingMethod`, `standardCost`,
  barcode/unitSku (resolved through `scan-search.ts` for every scan surface), and the
  parent/variant relation that variant-assign moves stock across. Products list also owns the
  `StockStatusFilter` that defines "low."
- **Finance / Bookkeeping → Inventory**: `getProfitAndLoss` sources COGS from SALE movements
  (currently none, so COGS = 0); `GET /inventory/valuation` supplies the stock-at-cost figure a
  balance sheet would need. COST_BASIS movements are the audit trail behind both.
- **Analytics → Inventory**: turnover, dead-stock and margin-alerts read Product stock plus
  invoiced sales (deliberately not StockMovement SALE rows), and — verified — sit behind the same
  `flag.analytics` gate as forecasting, with no client-side check.
- **Buyer portal → Inventory**: buyer catalogue tiles derive out-of-stock/low state from
  `currentStock`; Notify-me writes `StockAlert`; restock fire hooks push back through
  `NotificationsService.sendToCustomer`.
- **Regulated / compliance → Inventory**: `trackedCategoryId`/`trackedSubcategoryId` scope the
  Inventory Stock tab and feed monthly regulated reports; `regUomCase`/`regUomUnit` convert
  quantities for filings.
- **Billing / entitlements → Inventory**: `flag.forecasting` and `flag.analytics` (verified,
  previously undisclosed) both gate on the FORECASTING addon SKU. Any new inventory gate must have
  a UI that can grant it before it ships.
- **Notifications / Messaging → Inventory**: back-in-stock pushes go out through
  `NotificationsService.sendToCustomer`; the internal LOW_STOCK event is wired into the messaging
  config matrix but has no emitter.
- **Import / migration → Inventory**: opening balances load via `import.service.ts`, setting
  `currentStock` AND writing a StockMovement for the delta when it differs (verified — the
  movement write is real; the lot is indeed absent, as originally noted).

## What we could not verify

Everything marked SHIPPED cites a route, file+symbol, Prisma model or screen path read in this
session; nothing was run — not the API, the web app, the mobile app, or any test suite. Specific
limits on confidence:

1. No database was queried, so claims about production data volumes — most importantly "zero SALE
   movements exist" — rest on the verified absence of any production caller for
   `InventoryService.recordSale`, not on a row count.
2. Defect IDs (B25, B28, B53, B55, B61, B64, B69, B88, B115, B116, B168) are taken from the bug
   register as previously verified findings; the reconciliation pass above independently
   re-confirmed the B69 fix and narrowed B61, but did not re-prove every other ID.
3. UI claims are read from source, not from a rendered page — this includes the forecasting- and
   analytics-tab gating findings; a runtime check would still be worth doing.
4. Full 130KB+ files (the inventory service, the inventory page) were not read line by line —
   work proceeded from method signatures and targeted reads, so a small surface not grepped for
   could still exist off the paths checked.
5. The mobile purchase-order status/receive-gate defect (INV-N6) was upgraded from low-confidence
   code-map hearsay to a directly-cited defect in this reconciliation, but was not exercised on an
   actual device.
6. This domain's original analysis needed multiple corrections, two overstated claims, one
   flatly-false "not configurable" claim, and seven missed capabilities — treat any single
   uncited claim in adjacent documents describing this domain with caution until similarly
   checked.

> **Note:** This domain's analysis needed heavy correction (3 status corrections, 4 overstated
> claims requiring downgrade/removal-context, 5 understated claims, 7 missed capabilities) and is
> worth a second human pass before being treated as authoritative.
