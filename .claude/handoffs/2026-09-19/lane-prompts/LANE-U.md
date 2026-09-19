# Lane U — units of measure + purchase orders (window title: "RouteFlow Lane U")

Read `LANE-COMMON.md` first. Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-lane-U`, branches `feat/u-<step>`.
Plan: `local-assets/handoff/2026-09-18/PLAN-units-po-MINIMAL.md` (+ `units-po-plan/industry-patterns-uom-po.md`).
Evaluation cards U1 + U2. Flag: everything unit-facing behind plan preset key `units_v1`
(declare it the way `apps/api/src/billing/addon-gate-registry.ts` / plan-flag policy expects — ships dark).

## What already exists (do not rebuild)
`ProductUnit` (factorToBase, price..priceTier5, isDefaultSelling, sortOrder; unique per
product on label and factor), `SupplierProduct`, `unitLabel` on order/invoice lines,
`VendorBill.purchaseOrderId` — all on master via #936. PO API: `apps/api/src/inventory/`
(`POST purchase-orders`, `GET purchase-orders(/:id)`, `POST purchase-orders/:id/{send,receive,close}`),
web PO surface inside `apps/web/app/(dashboard)/inventory/page.tsx`, OCR
`POST /vendor-bills/scan-invoice` → `VendorBillsService.scanInvoice()`, per-line receipt with
`gapsDetected` (#934). Money helpers: `packages/pricing` (`computeLineSubtotal`,
`normalizeBoxesPieces`, `roundMoney`, `getTierPrice`).

## Order of work (one PR each; est. builder-days)
1. **Pricing ladder** — `resolveUnitPrice(product, units[], unitLabel, tierIndex)` +
   `toBaseQty` / `fromBaseQty` in `@routeflow/pricing`, with regression specs: factor 1 is
   the base; remainder loads on the last unit, never dropped; a level's explicit price wins,
   otherwise derived from the base price × factor; tier fallback matches `getTierPrice`. 1.0
2. **Product unit API + editor** — CRUD on `ProductUnit` (TENANT_ADMIN/OPERATOR), reject a
   factor edit once any line references the level (mint a new level instead — owner ruling
   "factors immutable"); barcode per level; web editor tab on the product page; default
   selling unit. 1.5
3. **Prefactor** — extract the PO section of `inventory/page.tsx` into
   `inventory/_components/PurchaseOrders*.tsx` (behaviour identical; F probe-diffs). 0.5
4. **Unit-aware write paths** (critical path) — every order/invoice/estimate/template line
   writer resolves the factor from the server ladder, never from client input; snapshots
   `(boxes, pieces, unitsPerBox, unitLabel)`; ONE helper `resolveLineUnits()` in the API and a
   meta-spec proving every line-writing path calls it. Opus review mandatory. 2.5
5. **Unit picker** — in `LineItemRow`, create-order, invoice lines; buyer portal stays on the
   product's default unit (ruled). 1.0
6. **PO edit + re-apply** — `PATCH purchase-orders/:id` for DRAFT/SENT; for received POs
   whole-document reverse then re-post (plan risk line accepted). 1.5
7. **PO from scan** — scan → draft bill lines → linked draft PO with the same lines (two
   documents, ruled) → receive (existing per-line path) → bill; hard-gate a bill that exceeds
   the PO's remaining qty/price. Web: Edit modal + "Create PO from scan". 2.0
8. Mobile: read-only unit labels + PO list. 0.5

Proof: pricing specs; F Playwright on the unit editor, order line picker and PO edit at
1440/768/390; repro-first proof on re-apply (F). Post PROOF-REQ per UI PR.

## Follow-up folded in (2026-09-19 07:1xZ)
- Step 7 also fixes the vendor-bill receive toast copy: web says "No action needed" while the API ConflictException tells operators to ask an admin about the product — make both say the same thing (Opus delta review of #934, copy-only).

## Follow-up folded in (2026-09-19 07:5xZ) — B571
- Step 6 (PO edit) also fixes **B571**: `apps/api/src/inventory/inventory.service.ts:1041-1065` creates `PurchaseOrderItem` via a nested `items: { create }` that never sets `tenantId` (the forTenant() extension cannot reach nested writes — the same footgun that produced three earlier backfills). Add `tenantId: this.prisma.getTenantId()` like the sibling models, plus a spec that a created PO's items carry the tenant. Do it in the FIRST PR that touches that file.
