# PLAN — Multi-level units + Purchase Orders — MINIMAL (re-scope of v4)

Verified against `origin/master` @ `6f49cbf5` on 2026-09-18. Supersedes `units-po-plan/PLAN-units-po-v4.md`
(≈ 113 lane-days). This plan: **≈ 57 hours ≈ 7 builder-days; ≈ 4 working days wall-clock on two lanes.**
It is not one day, and §3 shows exactly where the hours go: three quarters of them sit in the four
order/invoice write functions where a wrong pack factor is a money bug, and in the PO re-apply transaction.
The first thing the owner can use (define Case/Pallet with prices and a default selling unit) is ready
after ≈ 13 h — end of day 2 at the latest.

## 0. Two facts that make v4 wrong about size

1. **The web already has the PO surface v4 planned to build (v4 C8 was wrong).** `apps/web/app/(dashboard)/inventory/page.tsx`
   (3,303 lines) has create-PO with boxes + pieces + "Cost per Box", receive-PO in boxes/pieces, send, close,
   via the `apps/web/lib/api/inventory.ts` hooks (`useCreatePurchaseOrder`, `useReceivePurchaseOrder`, …). Only
   `/purchases` redirects to `/vendor-bills`. Mobile has the same seven screens. **Nothing to build but an
   Edit modal.**
2. **"Scan a supplier invoice → purchase record → stock moves" is already live — as a bill.** `ScanInvoiceModal`
   captures per line the supplier's `sku` and `packSize` (pieces per supplier unit), converts to pieces + per-piece
   cost (`toBillLine`), creates the `VendorBill`, and (when ticked) receives it in the same submit (lines 1306/1335).
   `VendorBillsService.receive` converts `packSize` lines and writes the movement + lot + `averageCost`.
   `ProductAlias` already learns supplier line text → product per supplier. The web bill form even shows a
   **"Purchase order" selector** (`vendor-bills/page.tsx:540-642`) whose `purchaseOrderId` the API accepts
   (`CreateVendorBillDto:56`) **and silently drops** — a latent bug this plan fixes by honouring it.

So the owner's asks 4 and 5 are ~70 % shipped. What is missing: a PO row raised from the scan and linked to
the bill, the PO moving stock instead of the bill when linked, **PO edit + the re-apply prompt**, and a remembered
(supplier, SKU) → (product, pack) mapping. Asks 1–3 are the genuinely new part.

## 1. Minimum data model — one additive migration, zero backfill, NULL = today's meaning

| table | change | why |
|---|---|---|
| **`ProductUnit`** (new, `catalog`) | `id`, `tenantId` (NOT NULL), `productId` (FK Cascade), `label String`, `factorToBase Int` (pieces per one unit), `price Decimal(10,2)?`, `priceTier2..5 Decimal(10,2)?` (NULL = derived), `isDefaultSelling Boolean @default(false)`, `sortOrder Int @default(0)`, `createdAt/updatedAt`. Uniques: `(productId, label)`, `(productId, factorToBase)`. | Asks 1 + 2 + 3. Rows exist **only for levels other than the pack** (Case, Pallet, Container … and an optional explicit "Piece" price row with `factorToBase = 1`). `Product.unitsPerBox` stays the pack; `Product.pricePerUnit` + tiers stay the pack price. A product with no rows is exactly today's product. Depth is unbounded — that is the "tenant-definable depth". |
| **`SupplierProduct`** (new, `catalog`) | `id`, `tenantId` (NOT NULL), `supplierId` (FK), `productId` (FK), `supplierSku String?`, `packSize Int?` (pieces per supplier unit), `lastUnitCost Decimal(10,4)?` (per supplier unit), `createdAt/updatedAt`. Unique `(tenantId, supplierId, productId)`; partial unique `(tenantId, supplierId, supplierSku) WHERE supplierSku IS NOT NULL` (raw SQL — same precedent as the product-name partial indexes). | Ask 5. Learned on scan confirm, consulted first on the next scan from that supplier. |
| `OrderItem`, `InvoiceItem` | `+ unitLabel String?` | The line's own unit name ("Case"). **Doubles as the "unit-aware line" marker** for guard (a). `unitsPerBox` on the line already stores the factor, `unitPrice` the price per that unit, `boxes/pieces/qty` the split — the existing triple *is* `(quantity, unit, factor)`, so `computeLineSubtotal`, the stock decrement, invoice copy, returns proration and the regulated non-split branch all work unchanged. A **piece-level** line on a boxed product is `{unitsPerBox: 1, boxes: null, pieces: null, qty, unitPrice: piecePrice, unitLabel: "Piece"}`. |
| `PurchaseOrderItem` | `+ sku String?`, `+ packSize Int?` | Mirrors `VendorBillItem` exactly so the scan's reviewed lines copy across. `qtyOrdered`/`unitCost` stay per piece (receive is untouched); supplier-unit display is derived (`qtyOrdered ÷ packSize`, `unitCost × packSize`). |
| `VendorBill` | `+ purchaseOrderId String? @unique` (FK → `PurchaseOrder`, SetNull) | The bill holds the link (v4 §3.4 direction survives). Linked ⇒ the PO is the stock mover, the bill is money only. |

`MODEL_DOMAIN`: `ProductUnit`, `SupplierProduct` → `catalog`. No enum, no NOT NULL on an existing table, no
column altered. `packages/types/api/products.ts` gains the `ProductUnit` shape; `orders.ts` / `invoices.ts` line
shapes gain `unitLabel?: string | null`. Migration: `CREATE TABLE ×2`, `ALTER TABLE ADD COLUMN ×5`, one unique +
one partial unique index (whitelist `-- squawk-ignore require-concurrent-index-creation` with a reason, as prior
migrations do). Prod apply per L-184: backup → `railway run --service postgres node apps/api/scripts/prod-migrate.mjs`
→ drift exit 0, **before** PR-1 merges.

Cut from v4's schema: `ProductUnit.code/sku/barcode/isBase/retiredAt/supersededById`; line
`unitCode/productUnitId/packUnitsPerBox`; `EstimateItem.unitsPerBox`; `OrderTemplateItem` / `RecurringInvoiceItem` /
`ReturnItem` columns; PO `stockTiming/confirmedAt/stockAppliedAt/sourceScanId/supplierRef/subtotal/taxAmount`; PO item
`unitLabel/unitFactor/unitQty/unitCostPerUnit/qtyApplied/qtyReconciled/productUnitId/lineTotal`;
`VendorBillItem.purchaseOrderItemId`; `SupplierProduct.unitLabel/unitFactor/leadTimeDays/minOrderQty/isPreferred`.

## 2. The rules (pure functions in `@routeflow/pricing`, each ≤ 25 lines + spec)

- **Price at a level** — `resolveUnitPrice({ packPrice, packFactor, level: { factorToBase, price, priceTierN }, tier })`:
  explicit `price` (tier 1) or `priceTierN` → it; else if tier 1 is explicit → `roundMoney(level.price × tierPackPrice ÷ packPrice)`
  (proportional to the pack's tier ladder); else `roundMoney(tierPackPrice × factorToBase ÷ packFactor)`.
  Piece = `factorToBase 1`. "12 pieces per box, set the piece price, box price follows" is this rule read the other
  way: the pack price is explicit on `Product`, the piece row's price is NULL → derived by division. **One rounding,
  at the end.**
- **The yes/no prompt (ask 2)** — client-side on the product page: when the operator changes any price and other
  levels hold *explicit* prices, prompt "Also update Case ($42.00 → $40.00), Pallet (…)? [Yes] [No]". Yes writes the
  derived values into those rows; No leaves them. Levels with NULL prices follow automatically and need no prompt.
- **Line denomination** — server helper `resolveLineDenomination(product, units, { unitLabel, boxes, pieces, qty })`
  in `apps/api/src/products/unit-levels.ts`: `unitLabel` absent → today's behaviour byte-for-byte; `"Piece"` →
  `{unitsPerBox: 1, qty}`; the pack's label → `{unitsPerBox: product.unitsPerBox}`; a `ProductUnit.label` →
  `{unitsPerBox: factorToBase}`; unknown label → 400. **The factor always comes from the server's ladder, never
  from the payload** (the existing B13 posture). Price = `resolveUnitPrice(...)` at the customer's tier unless staff override.
- **Display** — `formatQtySplit` gains an optional `boxLabel` (default `"box"`, additive): a CASE line prints
  "2 cases + 12 pcs"; nothing existing changes.

## 3. Build order — sized in hours, front-loaded to what the owner can see

Two file-disjoint lanes after step 0. Light loop (Sonnet build → Opus refute-first review) everywhere; steps 4, 6
and 7 are the money paths and get `pre-merge-review` plus a db-spec each.

| # | step | files | h | owner sees |
|---|---|---|---|---|
| 0 | Migration + Prisma models + `MODEL_DOMAIN` + shared types; `local:migrate`; drift green | `prisma/schema/{catalog,sales,finance}.prisma`, `migrations/2026091x_units_po_minimal`, `split-prisma-schema.mjs`, `packages/types/api/*` | 2 | — |
| 1 | `resolveUnitPrice`, `formatQtySplit(boxLabel)` + specs | `packages/pricing/src/{pricing,unit-levels}.ts` | 2 | — |
| 2 | `GET/PUT /products/:id/units` (replace-all ladder; integer factor ≥ 1, distinct, ≤ 1 default; **refuse when `trackedCategoryId != null`** — guard c) + spec; `findOne` includes `units` | `apps/api/src/products/{products.controller,products.service,unit-levels}.ts` | 3 | — |
| 3 | Product page **"Units & prices"** table: label · pieces-per-unit · price per tier (derived greyed, explicit black) · default-selling radio · add/remove level; the yes/no cascade prompt; Playwright 1440/768/390 | `apps/web/app/(dashboard)/products/[id]/page.tsx` (+ one component), `apps/web/lib/api/products.ts` | 6 | **Asks 1, 2, 3 defined on a product. ≈ 13 h in — day 2.** |
| 4 | Unit-aware line writes: `resolveLineDenomination` wired into orders `create()`, `updateOrderItems` staff branch, invoices `create` / `update`; DTOs accept `unitLabel`; invoice-from-order copies `unitLabel`; specs with the 4× case | `orders.service.ts` (~1950, ~3740), `invoices.service.ts` (~395, ~3448, ~905), `dto/*` | 8 | — |
| 5 | Web order + invoice editors: per-line unit picker (Piece / Box / Case / …), pre-selected to the product's default, price auto-filled from the level; line renders "2 cases"; PDF/list labels; Playwright | `orders/_components/CreateOrderModal.tsx`, `orders/[id]/page.tsx`, `invoices/new`, `invoices/[id]/edit` | 8 | **Sell by the case from the web; the invoice prints cases. ≈ 29 h in — day 4.** |
| 6 | Guard (a): `assertUnitAwareLinesUntouched(existing, incoming)` — 409 `UNIT_AWARE_LINE` with an operator-readable message, **compared in pieces**; called in `updateOrderItems` buyer + driver branches, `approveChangeRequestAtStop`, buyer merge (`buyer.controller.ts:613`), POST /orders scan-merge (`orders.controller.ts:221`); one `warn` log line; spec | `apps/api/src/orders/unit-aware-guard.ts` + 5 call sites | 4 | Driver/buyer apps cannot mis-price a case line. |
| 7 | PO: `PATCH /inventory/purchase-orders/:id { items, notes, expectedDate, reapplyInventory }` — DRAFT/SENT edit freely; PARTIAL/RECEIVED with `reapplyInventory: true` = one `tenantTransaction`: reverse every movement/lot with `reference = poNumber` (mirror `VendorBillsService.revertToDraft` + `reverseBillLots` + `reverseAverageCost`), reset `qtyReceived`, apply edits, re-receive in full; `false` = document-only (`qtyOrdered ≥ qtyReceived` enforced). Bill guards (e): `receive` / `revertToDraft` / `voidBill` skip the inventory block when `purchaseOrderId != null`. `VendorBillsService.create` honours `purchaseOrderId` and, with `createPurchaseOrder: true`, creates the PO from the same lines in the same tx. `roundMoney` on `totalAmount`; `currentStock: { increment }` in `receivePurchaseOrder` (guard d). db-spec: receive → edit qty + cost → re-apply → stock and `averageCost` equal a fresh receive of the edited lines | `inventory.service.ts` (1028–1263), `inventory.controller.ts`, `dto/create-purchase-order.dto.ts`, `vendor-bills.service.ts` (184, 723, 941, 1062), `create-vendor-bill.dto.ts` | 8 | — |
| 8 | Scan modal: **"Raise purchase order" toggle (default on)** → PO + linked bill; "Receive now" routes to `receivePurchaseOrder`. Inventory PO tab: **Edit** modal; on a received PO the save asks **"Re-apply to inventory?"** [Re-apply] [Keep stock as is]; lines show supplier SKU + "12 × case of 24"; the bill form's PO selector now works; Playwright | `components/ScanInvoiceModal.tsx`, `inventory/page.tsx` (PO tab), `lib/api/{inventory,vendor-bills}.ts` | 6 | **Ask 4 end-to-end: scan → PO → stock → edit → re-apply prompt. ≈ 47 h in — day 6.** |
| 9 | `SupplierProduct`: upsert on scan confirm for every line with `productId` + `sku` (`packSize`, `lastUnitCost`); a new **first** resolution tier in `scanInvoice` matching — exact supplier SKU for that supplier → `productId` + `packSize` prefilled (`matchSource: "supplier-sku"`); spec | `vendor-bills.service.ts` (scanInvoice, create), `product-matcher.ts`, `supplier-products.service.ts` (new, ~80 lines) | 4 | **Ask 5: "the invoice has the piece SKU" is remembered after one confirmation.** |
| 10 | `npm run verify`; `local:up` → `local:validate` → `local:e2e`; `pre-merge-review` on PR-2/PR-3; Option-B bookkeeping (code-map rows for the touched files, a lesson only if one is earned); prod migration gate; one public window per batch | — | 6 | Shipped. |

**Total ≈ 57 h.** One builder: 7 working days. Two lanes (units = 1–6, PO = 7–9, both after 0): ≈ 4 working days
wall-clock, one migration, three PRs (PR-1 = 0–3, PR-2 = 4–6, PR-3 = 7–9; PR-2 + PR-3 can share one public window).

Where the hours really go: steps 4–6 (20 h) — `orders.service.ts` and `invoices.service.ts` are 6,000-line files
whose write paths derive the factor from the live product in ~12 places (`orders.service.ts:3761, 4153, 4364, 4518`;
`invoices.service.ts:397, 3450`), and each is a 4× money bug if a unit-aware line passes through it. Step 7 (8 h)
is a reversal transaction over stock and average cost. Everything else is ≈ 3 days of ordinary CRUD and UI.
There is no honest way to make the money paths a two-hour job.

## 4. What is cut — and why it is safe to defer

| v4 item | v4 cost | cut / replaced by | why safe now |
|---|---|---|---|
| S0 "semantic concurrency definition" + isolation-level work | 4.5 d | `currentStock: { increment }` in PO receive (one line) | The bill path already does this; the absolute write was the only PO-side hazard. |
| S1 baseline/compare scripts, Step 5 prod-dump rehearsal, `down.sql` proofs | 5.5 d | additive migration + `local:validate` + drift gate + L-184 | Nothing legacy is written; a NULL column cannot move stock or money. |
| `qtyApplied` + backfill script + reconciliation identity + `--adopt` | ~4 d | reverse-by-`reference = poNumber` (the pattern bills use today) | Every PO movement already carries `reference = poNumber`; legacy received POs are editable too. |
| Delta posting engine (S8b), state table × 2 modes, STANDARD branch | 8.5 d | whole-document reverse + re-receive in one tx | The semantics the bill already has in production; see risk 1. |
| Per-tenant `stockTiming` + settings reader/writer (S11a/b) | 5 d | stock moves at receive; the scan review's "Receive now" tick (exists) | The owner's "at PO creation" is that ticked box. |
| `ProductUnit` codes enum, sku/barcode per level, supersession/`retiredAt`, non-nesting policy | ~3 d | free `label`; factor editable in place | Lines snapshot their factor (guard a), so editing a factor cannot touch an open document. |
| `unitCode/productUnitId/packUnitsPerBox` on lines; regulated conversion (v4 C10) | ~2 d + | one `unitLabel`; guard (c) refuses levels above the pack on regulated products | A filing can never see a pallet counted as a case because such a line cannot exist in v1. |
| Estimates / recurring / templates / returns unit support (S4b half, S7) | ~5 d | those surfaces keep selling the pack | Not asked for; none of them can mis-price because they never carry `unitLabel`. |
| Mobile unit picker, mobile PO edit, S10m, OTA rollout runbook, per-tenant 409 rollout | ~8 d | mobile unchanged; guard (a) 409s with an operator-readable message the apps already render verbatim (`adjust.tsx:302`, `edit-items.tsx:907`) | Unit-aware lines exist only after a tenant defines levels and sells one from the web — the tenant opts in by using it. |
| Buyer-portal / cart unit picker (v4 Q3) | 4 d | buyers order the pack | The ask was an operator default, overridable per order — that is the web editor. |
| Three-way match, `GoodsReceipt`, PPV, over-receipt band, multiple bills per PO (v4 D9), per-line bill↔PO match | ~6 d | one bill per PO, no line matching | Nothing the owner described. |
| `SupplierProduct` lead time / MOQ / preferred / CSV import-export | 1 d | four columns | The ask was "their SKU and their unit". |
| B562 fix as a gate before T2b | 2.5 d | independent bug-pipeline item (already filed) | The PO path never calls `recomputeProductInTx`; linked bills now skip the inventory block, which removes one of B562's triggers rather than adding one. Fix B562 on its own merits. |
| Tenant settings, `derivationPrecedence`, `allowNonNestedLevels`, runbook S12, 22 Option-B follow-ups | ~4 d | one derivation rule; three PRs | Fewer knobs, fewer PRs, same money. |

**The three biggest cuts:** delta posting + `qtyApplied` machinery (≈ 12.5 d); the migration proof / rehearsal /
backfill apparatus (≈ 5.5 d); mobile parity + rollout runbook (≈ 8 d).

## 5. Risk accepted by cutting — the owner can overrule any line by number

1. **Re-apply is a whole-document reverse + re-receive.** If sales happened between the original receipt and the
   edit, `reverseAverageCost` restates the average approximately and stock can pass through negative inside the
   transaction — exactly what bill `revertToDraft` does today. Exact restatement needs delta posting (Phase 2).
2. **A driver or buyer cannot change the quantity of a case-sold line from the app** (409, "edit from the web").
   Price-only edits, deletes and unchanged resubmits pass. Per-path pinning (v4 §2.14) lifts this in Phase 2.
3. **The default selling unit is honoured on the web order/invoice editors only.** Mobile, buyer portal, templates,
   estimates and recurring invoices keep selling the pack.
4. **No unit levels above the pack on regulated (tobacco) products** until the report converts (Phase 2, ≈ 2 h).
5. **Document-only PO edits (`reapplyInventory: false`) let PO cost diverge from valuation** — by the operator's
   explicit choice on the prompt.
6. **Mobile invoice scan still raises a bill that moves stock** (no PO) until the mobile modal gets the toggle.
7. **Analytics "boxes sold" counts a case as one box** — display-only; the regulated reports are guarded.
8. **Free-text level labels** ("Case" vs "case" across products) — cosmetic; unique per product only.
9. **One bill per PO.** A supplier splitting one PO across two invoices: close short + new PO, as v4 D9.

## 6. Where v4 was right — kept because it is load-bearing and cheap

- **The seam: relabel the triple, don't rewrite it** (v4 §2.2). It is the single reason this plan is a week and
  not a quarter — `(boxes, pieces, unitsPerBox, unitPrice)` already *is* `(quantity, factor, unit price)`.
- **A line stores its own factor and never re-reads the product's** (guard a) — the verified 4× at-the-door overcharge.
- **Compare in pieces, never on the split** (B-R3-F3) — full-set clients re-split every line against the live pack;
  without this the gate would 409 on unchanged lines. It is ~6 lines inside the helper.
- **The server resolves the factor from the ladder; the client's factor is a signal** (B13).
- **The bill holds the link; the PO is the stock mover when linked; a DRAFT PO never moves stock** (D1/D2 — the
  "Receive now" tick decides).
- **`roundMoney` on `totalAmount`** — `createPurchaseOrder` sums `qtyOrdered * item.unitCost` unrounded today.
- **`tenantId NOT NULL` on the new tables**; L-184's prod-migration gate; **B562 filed and independent**.
- **No new caller of `recomputeProductInTx`** — one grep in review.

## 7. Guards kept (each prevents a concrete money/stock failure; nothing else is a gate)

| | guard | prevents | cost |
|---|---|---|---|
| a | rewrite paths never re-derive a unit-aware line's factor (`unitLabel != null` ⇒ 409 on a quantity change, compared in pieces) | the verified 4× overcharge when a driver edits a case line at the door | 4 h (step 6) |
| b | no existing row is rewritten; NULL keeps today's meaning; no backfill | any regression across the 1,058 existing call sites | 0 |
| c | no level above the pack on `trackedCategoryId != null` products | a tobacco filing counting a pallet as one case | 1 line |
| d | `currentStock: { increment }` in PO receive | a concurrent order's stock decrement silently lost | 1 line |
| e | a bill with `purchaseOrderId` never touches stock (receive / revert / void) | a scanned delivery counted twice (PO + bill) | 3 `if`s |
| f | factor resolved server-side by label | a stale client writing a wrong factor | inside step 4 |
| g | re-apply runs in one `tenantTransaction` | a half-reversed PO | inside step 7 |

## 8. Phase 2 (deferred, not deleted)

Per-path factor pinning on every rewrite path (lifts risk 2) · delta posting for PO edits · `stockTiming` per tenant ·
mobile unit picker + PO edit + scan-to-PO toggle · buyer-portal unit picker · estimates / recurring / templates /
returns units · regulated case-conversion for above-pack lines · level SKU / barcode · supersession history ·
`SupplierProduct` lead time / MOQ / preferred / CSV · multiple bills per PO · line-level bill↔PO matching ·
three-way match / PPV · tenant-defined level vocabulary · `regUomCase` bucketing for legacy pack changes ·
B562 (its own bug-pipeline run).
