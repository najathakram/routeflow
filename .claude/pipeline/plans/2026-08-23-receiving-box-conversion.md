# Plan: inventory receiving box→piece conversion (client-critical stock corruption)

> Status: IMPLEMENTED (2026-08-23, autopilot; 14 findings confirmed and fixed incl. loud-fail receive guard; 2 mobile stragglers hand-fixed) · Authored 2026-08-23 from the verified 2026-08-22 recon. This file is the ONLY
> context implementers receive. Root causes are CONFIRMED — implement, do not re-investigate.

## ⚠️ WORKTREE — read before anything else

ALL work happens in:

```
C:\ClaudeCode\routeflow\.claude\worktrees\ap-inv-units
```

Your process may start in `C:\ClaudeCode\routeflow` (main checkout) — do NOT touch files there.
`cd` into the worktree before ANY command and use ABSOLUTE paths under the worktree for every file
read/edit. Relative paths in this plan are relative to the worktree root. Branch is already
`fix/receiving-box-conversion`; do not commit, stage or push — the orchestrator handles git.

## Objective

A live client's on-hand stock reads `-1627.00 BOX`. Cause: stock is denominated in PIECES
system-wide, sales correctly decrement pieces, but the two RECEIVING paths write the operator's raw
entered number (which they think of as boxes) with no box→piece conversion — so receipts are
undercounted by `unitsPerBox` and on-hand drifts hugely negative. The display then mislabels the
piece count with the box noun.

## The established unit contract (do not re-litigate)

`Product.currentStock`, `Product.averageCost` (per PIECE), `StockMovement.quantity`, `StockLot.qty`
are all PIECES. Evidence: `apps/api/src/common/pricing.ts` ~L137-146 states it;
`apps/api/src/vendor-bills/vendor-bills.service.ts` `lineInventoryDelta` (~L139-151) multiplies
case-priced bill lines by pack size before touching inventory, with a comment about preserving the
per-piece contract; order creation decrements the piece total produced by `normalizeBoxesPieces`
(`apps/api/src/common/pricing.ts` ~L56-80).

## Confirmed defective paths

1. `InventoryService.recordPurchase` (`apps/api/src/inventory/inventory.service.ts` ~L166-245) —
   reached from web "Quick Restock" (`apps/web/app/(dashboard)/inventory/page.tsx` ~L181-279 →
   `apps/web/lib/api/inventory.ts` ~L29-39 → `POST /inventory/movements/purchase`). Writes
   `dto.quantity` RAW into currentStock, average-cost math, the StockMovement row and the StockLot
   row. `RecordPurchaseDto` (`apps/api/src/inventory/dto/record-purchase.dto.ts`) has only a bare
   `quantity`.
2. `InventoryService.receivePurchaseOrder` (~L1090-1166) — identical gap; PO item DTOs
   (`apps/api/src/inventory/dto/create-purchase-order.dto.ts`) carry only bare quantities.
3. Display: on-hand renders `{currentStock} {product.unit}` (piece count, box noun) on
   `apps/web/app/(dashboard)/products/[id]/page.tsx` and the inventory list.
   `apps/web/app/(dashboard)/products/[id]/DemandCard.tsx` `unitsLabel()` (~L105-117) already shows
   the correct pattern: pieces plus a `(X boxes + Y pcs)` breakdown via `normalizeBoxesPieces`.

## ⚠️ THE CONTRACT RULE — getting this wrong corrupts more data than it fixes

A bare `quantity` field KEEPS meaning PIECES. Never silently reinterpret it as boxes. Conversion
happens ONLY when the payload explicitly carries the new boxes/pieces shape. Every existing
piece-denominated caller (mobile, import scripts, seeds, tests) must behave byte-for-byte as
before.

## Work packages

### WP1 — API: receiving converts explicitly-boxed payloads to pieces (files: `apps/api/src/inventory/dto/record-purchase.dto.ts`, `apps/api/src/inventory/dto/create-purchase-order.dto.ts`, `apps/api/src/inventory/inventory.service.ts`, `apps/api/src/inventory/inventory.service.spec.ts`)

1. `RecordPurchaseDto`: add optional `boxes?: number` and `pieces?: number`
   (`@IsOptional() @IsInt() @Min(0)` each). Semantics: if EITHER is present, the received piece
   quantity is computed from them and `quantity` is ignored for stock math (validate that at least
   one of quantity/boxes/pieces yields a positive total; reject negative).
2. In `recordPurchase`, at the top, resolve the piece quantity exactly once — the tricky code:

   ```ts
   // Boxed payloads convert to pieces up front; a bare `quantity` KEEPS meaning
   // pieces (existing callers must be untouched). Mirrors vendor-bills'
   // lineInventoryDelta contract: everything below this line is PIECES.
   const explicitBoxed = dto.boxes != null || dto.pieces != null;
   const qtyPieces = explicitBoxed
     ? normalizeBoxesPieces(dto.boxes ?? 0, dto.pieces ?? 0, product.unitsPerBox ?? 1).qty
     : dto.quantity;
   ```

   (Import `normalizeBoxesPieces` from `../common/pricing`. Check its real signature/return shape
   in `apps/api/src/common/pricing.ts` first and adapt — the intent is
   `boxes * unitsPerBox + pieces`.) Use `qtyPieces` for currentStock increment, next-average-cost
   math, the StockMovement quantity and the StockLot qty. Note `unitCost` semantics: when the
   payload is boxed, decide the cost basis explicitly — if the DTO's cost field is per box (read
   the web modal to see what it sends today), convert to per-piece before AVCO math
   (`costPerPiece = costPerBox / unitsPerBox`, via `roundMoney` only at persistence, keep full
   precision inside AVCO). State in your report exactly which cost convention you implemented.

3. Same treatment inside `receivePurchaseOrder`: add optional `boxes`/`pieces` to the receive-item
   DTO shape it consumes, resolve `qtyPieces` identically, keep bare quantities meaning pieces.
4. Specs in `inventory.service.spec.ts` (extend existing suites, mock at the Prisma boundary):
   (a) boxed receive — `unitsPerBox 24`, `boxes: 5` → stock +120, StockMovement.quantity 120,
   average cost per piece; (b) bare `quantity: 120` behaves exactly as before (regression pin);
   (c) PO receive with boxes converts identically.

### WP2 — web: Quick Restock + PO forms collect unambiguous units (files: `apps/web/app/(dashboard)/inventory/page.tsx`, `apps/web/lib/api/inventory.ts`)

For products with `unitsPerBox > 1`, the Quick Restock modal collects boxes + pieces (two inputs,
same pattern the stock-count UI uses elsewhere in this page) and sends `{ boxes, pieces }`;
non-boxed products keep the single quantity input sending `{ quantity }` (pieces). Label the cost
input to match the convention WP1 implements (per box vs per piece) so the operator knows what they
are typing. Apply the same to the Create-PO / Receive-PO forms in this page, and keep the
"Ordered vs Received" comparison consistent in whatever unit it now displays. Update the client
typings in `apps/web/lib/api/inventory.ts`.

### WP3 — web: on-hand displays the unit it stores (files: `apps/web/app/(dashboard)/products/[id]/page.tsx`)

Reuse the `unitsLabel()` pattern from `DemandCard.tsx` (~L105-117) — extract it into a small shared
helper (put it in `apps/web/lib/` or export from where it lives, whichever is cleaner) and render
on-hand as pieces with a `(X boxes + Y pcs)` breakdown when `unitsPerBox > 1`, instead of
`{currentStock} {product.unit}`. Also grep `apps/web` for other places `currentStock` renders next
to `product.unit` and fix them the same way (the inventory list page is handled in WP2's file —
coordinate: WP2 owns `inventory/page.tsx`, so if the on-hand cell there needs the same fix, note it
in your report for WP2's engineer or the fixer, do NOT edit that file yourself).

### WP4 — read-only drift report script (files: `apps/api/scripts/report-receiving-unit-drift.mjs`)

New script, READ-ONLY, no `--execute` mode. For each tenant, for products with `unitsPerBox > 1`:
reconstruct expected on-hand assuming PURCHASE StockMovements written by the buggy paths were
entered in BOXES (multiply by unitsPerBox) versus as stored, compare with invoiced/ordered piece
sales, and print suspected under-received products with proposed correction and a LOW/MED/HIGH
confidence. Follow the structure of existing read-only report scripts in `apps/api/scripts/`
(pick one as a template for arg parsing/db access via the generated Prisma client). It must
`require` and call `assertTestTenant` from `scripts/lib/test-tenants.cjs` before any write branch
it might ever grow (today it has none — still wire the guard with a comment). Never name a live
tenant anywhere in the file.

## Explicitly OUT of scope — do not touch

`InventoryService.recordSale` (dead code; sales decrement via bare Product.update in
orders.service.ts with no StockMovement row — known, separately tracked) · any data repair
execution · mobile UI (mobile has no Quick Restock modal; verify and note if wrong) ·
`.claude/code-map` (orchestrator updates it).

## Acceptance criteria

1. Boxed receive (24/box, 5 boxes) lands +120 pieces everywhere (stock, movement, lot) with
   per-piece average cost — proven by spec.
2. Bare `quantity` payloads are byte-for-byte unchanged in behavior — proven by spec.
3. Existing inventory/costing specs pass unmodified (except where they assert the new DTO shape).
4. On-hand never renders a piece count with a box noun on the touched pages.
5. The drift script runs read-only and names no live tenant.

## Verification commands (from the worktree root)

```
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-inv-units && npm run check-types
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-inv-units && npm run lint
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-inv-units && npm run test
```
