# PR-5 — scanner match memory + boxes/pieces on scanned lines

**Status:** IMPLEMENTED — shipped 2026-08-18/19; see the PR for the verified final shape
**Scale:** major (api + web + mobile; touches receive-time stock and cost denomination)
**Sources of truth:** `.claude/pipeline/decisions/2026-08-18-batch-architecture.md` **§A3** (the `toBillLine` contract — binding) and **§PR-5** (alias scope, unlearn, cache path). Also `docs/plans/mobile-ux-batch-2026-08-17.md` §PR-5. Decisions doc wins on conflict.

**Already shipped in PR-B (#356) — do NOT redo:** the tenant-safe `saveProductMapping` rewrite and its `SaveProductMappingDto`. That was PR-5's commit 1, pulled forward because it was a live cross-tenant bug.

## Context

Two owner asks, both about the invoice-scan flow.

**1. The scanner should remember corrections.** When an operator fixes a mis-matched line on a scanned supplier invoice, the next scan of the same supplier line should match it automatically. A memory already exists (`ProductMapping`, consumed tier-0 in scans) but the correct replacement — `ProductAlias`, tenant-scoped and normalized — exists with `resolve()` **never called**.

**2. Scanned lines are quoted in the wrong unit.** A supplier bills "24 pcs @ $1.25" for something the catalog stocks as a case of 24. The operator needs a Boxes/Pieces toggle. This is money-critical at receive time.

**The trap (A3):** `lineInventoryDelta` (`vendor-bills.service.ts:133-145`) is the ONLY conversion point for receive/revert/void, and it converts **only when `item.packSize > 1`** (`qty.mul(pack)`, `unitCost.div(pack)`). A Boxes line posted without `packSize` books **1 piece at $30 instead of 24 at $1.25** — the exact #335/#336 stock/AVCO corruption class. So `packSize` is part of the return value, always explicit.

## Non-goals / do not touch

- **No Prisma migration.** `ProductAlias` and `InvoiceScan.supplierId` are already in the baseline.
- Do NOT retire the legacy `ProductMapping` read tier (later cleanup).
- Do NOT rewrite `extractedPayload` on a cached scan (fingerprints and history must stay stable).
- Do NOT touch `pricing.ts` money helpers beyond the **additive** `roundUnitCost`.
- Do not touch drafts (PR-3), van sale (PR-4), driver flows, or the buyer portal.

## Work packages

### WP1 — pure unit conversion (`apps/{web,mobile}/lib/scan-line-units.ts`)

**Files owned:** `apps/mobile/lib/scan-line-units.ts` (new), `apps/web/lib/scan-line-units.ts` (new), `apps/mobile/__tests__/scan-line-units.test.ts` (new), `apps/mobile/lib/pricing.ts`, `apps/web/lib/pricing.ts`

1. Add **`roundUnitCost(n)`** — 4 decimal places — beside `roundMoney` in BOTH `apps/mobile/lib/pricing.ts` and `apps/web/lib/pricing.ts`. Purely additive; do not alter any existing helper. Add a comment cross-referencing `COST_DP = 4` in `apps/api/src/inventory/costing.ts` and noting the deliberate asymmetry (the API's equivalent lives in `inventory/costing.ts`, not its `pricing.ts`).
2. Create the two identical mirrors of `scan-line-units.ts`:

```ts
export type ScanLineUnit = "pieces" | "boxes";
export interface PieceSnapshot {
  qtyPieces: number;
  costPerPiece: number;
}
export interface BillLineDenomination {
  qty: number; // in the chosen unit (cases when unit="boxes")
  unitCost: number; // per chosen unit, roundUnitCost (4dp)
  packSize: number | null; // piecesPerBox when boxes, else null — ALWAYS present
  converted: boolean;
  warning?: "NOT_DIVISIBLE" | "PPB_MISMATCH";
}
export function toBillLine(
  snap: PieceSnapshot,
  unit: ScanLineUnit,
  piecesPerBox: number | null | undefined,
  catalogUnitsPerBox?: number | null,
): BillLineDenomination;
```

Rules:

- `unit="pieces"` ⇒ `{qty: qtyPieces, unitCost: roundUnitCost(costPerPiece), packSize: null}`.
- `unit="boxes"` requires **integer `piecesPerBox >= 2` AND `qtyPieces % piecesPerBox === 0`** ⇒ `{qty: qtyPieces/ppb, unitCost: roundUnitCost(costPerPiece*ppb), packSize: ppb}`. Otherwise return the **pieces** form plus `warning: "NOT_DIVISIBLE"` — never fractional cases; they drift stock at receive.
- When `catalogUnitsPerBox` is present and differs from the effective ppb, add `warning: "PPB_MISMATCH"`. **The on-screen ppb wins** (what is displayed is what is saved); the catalog value only prefills when OCR gave none.

3. Spec (`apps/mobile/__tests__/scan-line-units.test.ts` is the executable contract for BOTH mirrors) must pin:
   - **Money invariant:** `roundMoney(qty × unitCost)` identical across both representations of the same snapshot.
   - **Round-trip:** pieces → boxes → pieces restores the snapshot exactly.
   - `NOT_DIVISIBLE` (e.g. 25 pieces with ppb 24) stays in pieces with the warning and `packSize: null`.
   - `PPB_MISMATCH` when the catalog says 12 and the operator's ppb is 24 — and the result uses **24**.
   - `packSize` is present (explicitly `null` for pieces) on every return.

### WP2 — alias resolution + supplier match + cache path (`apps/api`)

**Files owned:** `apps/api/src/import/supplier-match.ts` (new), `apps/api/src/import/supplier-match.spec.ts` (new), `apps/api/src/import/product-alias.service.ts`, `apps/api/src/import/product-alias.module.ts` (new if absent), `apps/api/src/vendor-bills/vendor-bills.service.ts`, `apps/api/src/vendor-bills/vendor-bills.service.spec.ts`, `apps/api/src/vendor-bills/vendor-bills.module.ts`

1. Move batch-import's private `matchSupplier` into `import/supplier-match.ts` (exact → unique startsWith → unique contains) and re-use it from both callers; spec it.
2. `ProductAliasService` gains **`resolveMany(supplierId, rawTexts[])`** (batched; no tenant ⇒ empty map; drops aliases whose product no longer exists) and **`unlearn(supplierId, rawText)`**.
   - **Unlearn deletes BOTH scopes (binding):** `deleteMany({ tenantId, rawText: normalize(rawText), supplierId: { in: [sid, ""] } })`. The operator's intent is "stop suggesting this", and the suggestion may have come from the `""` any-supplier fallback that a supplier-scoped delete would miss. Return `{ deleted }`; spec the two-scope delete.
3. `scanInvoice`: resolve `supplierId` server-side via `supplier-match`; result gains `supplierId`; `persistScan` writes `InvoiceScan.supplierId`. Items gain `matchSource?: "alias" | "memory"`.
4. **Extract the Phase-2 matching block (~`vendor-bills.service.ts:1270-1338`) into a private `matchItems(supplierRaw, items)`** and run it on **BOTH** paths:
   - the fresh scan path, and
   - **the `findScanByHash` cache hit** — strip stale match fields (`matchedProductId`, `matchedProductName`, `confidence`, `candidates`, `matchSource`) from the cached payload's items and re-match in memory (alias tier → legacy mapping tier → fuzzy) before returning.
     Without this, a rescan of the same file returns the cached payload **before any matching runs**, so a just-taught alias never applies and "rescan shows Remembered match" is impossible. **Do NOT rewrite the stored `extractedPayload`.**
5. `saveProductMapping` (already tenant-safe from PR-B) **dual-writes**: call `alias.learn(supplierId, raw, { productId })` **only when a supplier was actually resolved** — never under `supplierId: ""` from the scan flow (the `""` scope stays reserved for batch-import's any-supplier aliases). Clearing a match calls `unlearn`.
6. Extend `vendor-bills.service.spec.ts`: alias beats legacy mapping beats fuzzy matcher; the cache path re-matches; unlearn hits both scopes; no alias is learned when the supplier is unresolved. The prisma mock will need `productAlias` and `supplier`.

### WP3 — backfill script (`apps/api/scripts`)

**Files owned:** `apps/api/scripts/backfill-product-aliases.mjs` (new)

Migrate legacy `ProductMapping` rows to `ProductAlias`. **Dry-run by default; `--apply` to write; idempotent.**

- Normalize `rawText` with the SAME helper `ProductAliasService` uses (import it — do not re-implement; a copy that drifts writes aliases `resolve()` can never match).
- Resolve each row's supplier per-tenant via `supplier-match`.
- Group by `(tenantId, resolvedSupplierId, normalizedRawText)`; on collision keep the most recently `updatedAt` row and **print a collision report in dry-run** (count + a sample) so the owner can eyeball it before applying.
- `createMany({ skipDuplicates: true })`. Skip and report NULL-tenant / NULL-product rows.
- Never write when `--apply` is absent. Follow the house script conventions (see other `apps/api/scripts/*.mjs`).

### WP4 — web: remembered badge, supplier prefill, unit toggle, case-cost fix (`apps/web`)

**Files owned:** `apps/web/lib/api/invoice-scan.ts`, `apps/web/components/ScanInvoiceModal.tsx`, `apps/web/app/(dashboard)/vendor-bills/[id]/page.tsx`, `apps/web/components/SearchableProductPicker.tsx`

1. Types gain `supplierId` and `matchSource`; `applyScan` prefers the **server-resolved** `supplierId`.
2. `ConfidenceBadge` gains a **"Remembered match"** variant (shown for `matchSource === "alias" | "memory"`), with a tooltip saying clearing it forgets the match. Clear `matchSource` on manual change.
3. **Boxes/Pieces toggle on scanned lines:** unit is DERIVED from `packSize > 1`; keep a UI-only `ppbDraft` plus a `preConvert` **canonical `PieceSnapshot`** so toggling is lossless (an OCR case line of 1 @ $30 with packSize 24 canonicalizes to {24, 1.25} and toggling back restores the original values exactly — never a re-derivation). A `[Boxes|Pieces]` mini-toggle replaces the bare "× N pcs" block. Linking a product **arms `ppbDraft` from `unitsPerBox` but never silently sets `packSize`**. Surface the `NOT_DIVISIBLE` and `PPB_MISMATCH` warnings. Post-convert show "from 24 pcs @ $1.25".
4. **Bug fix:** `vendor-bills/[id]/page.tsx` prefills a piece cost into the case-cost field when linking a boxed product. Mirror mobile's `linePrefillFor` (case cost = `averageCost × unitsPerBox` when boxed). Widen `SearchableProductPicker.PickerProduct` with `unitsPerBox`/`averageCost` to kill the `as any`.

### WP5 — mobile: confirm-only learning + line editing (`apps/mobile`)

**Files owned:** `apps/mobile/lib/vendor-bill-scan.ts`, `apps/mobile/app/(operator)/vendor-bills/scan.tsx`, `apps/mobile/components/LineEditSheet.tsx` (new), `apps/mobile/__tests__/vendor-bill-scan.test.ts`

1. `linkScanItem` sets `operatorConfirmed`; **`mappingsFromScan` filters on it** so the app stops teaching itself its own auto-guesses. `buildBillDtoFromScan` prefers the server `supplierId`.
2. Scan review rows gain "· remembered" in the meta line when `matchSource` is set.
3. New `LineEditSheet` (FormSheet pattern): qty, `[Boxes|Pieces]` pills, pieces-per-box prefilled OCR-then-product, unit cost, live line total, warnings. Backed by a pure `applyLineEdit` in `vendor-bill-scan.ts` that delegates to `toBillLine`.
4. **Every DTO line that passed through the toggle carries `packSize` explicitly (including `null`)** — spec it; a stale OCR `packSize` must never survive beside a Pieces choice.

### WP6 — API receive-path equivalence spec (`apps/api`)

**Files owned:** `apps/api/src/vendor-bills/vendor-bills.receive-units.spec.ts` (new)

The client-side unit specs prove nothing about the server. Pin the invariant where the money actually moves: receiving `{qty: 1, unitCost: 30, packSize: 24}` and `{qty: 24, unitCost: 1.25, packSize: null}` must produce **identical** stock deltas and AVCO, and revert/void must reverse each exactly. Follow the existing `vendor-bills.service.spec.ts` mocking style.

## Acceptance criteria

- [ ] `toBillLine` always returns `packSize` (explicitly `null` for pieces); a Boxes conversion never omits it.
- [ ] A non-divisible piece count stays in pieces with `NOT_DIVISIBLE` — fractional cases are impossible.
- [ ] Pieces→boxes→pieces round-trips exactly; `roundMoney(qty × unitCost)` is identical across representations.
- [ ] A rescan of an identical file re-runs matching and can show "Remembered match" (cache path calls `matchItems`); `extractedPayload` is not rewritten.
- [ ] `unlearn` deletes both the supplier-scoped and `""`-scoped alias rows.
- [ ] The scan flow never learns an alias under `supplierId: ""`.
- [ ] Mobile learns only from operator-confirmed links.
- [ ] The backfill script writes nothing without `--apply` and normalizes with the shared helper.
- [ ] API spec proves both denominations receive identically.
- [ ] No Prisma migration; no change to existing `pricing.ts` helpers beyond additive `roundUnitCost`.

## Verification

```
npx turbo run check-types lint test --filter=@routeflow/api --force
npx turbo run check-types lint test --filter=@routeflow/mobile --force
npx turbo run check-types lint --filter=@routeflow/web --force
npm run verify
```
