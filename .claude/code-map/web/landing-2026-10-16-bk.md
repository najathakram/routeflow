# Web landing 2026-10-16 (#3473, #3471, #3472, #3460, #3474)

Range `96fc7351f..b6ed040dc`, web side. Paths under `apps/web/` unless noted. Api: `api/landing-2026-10-16-bk.md`. Tests not indexed.

## #3471 buyer cart (row 531)

- `lib/buyer-cart-line.ts` (NEW) the one pure cart-line module: `CartUnit` ("CASE" | "EACH"), `CartLineShape`, `isBoxedLine`, `isLineConsistent`, `lineUnit`, `cartOrderItems` (the only checkout payload builder), `BUYER_QTY_SPLIT_MISMATCH_COPY`. Quantity is the truth in pieces; the split is derived through `@routeflow/pricing` on every change. `lib/buyer-cart.ts` loads saved carts quantity-first, flags rebuilt lines and shows the one-time "corrected the quantity" banner; a pack-size change keeps the Case count (Case lines) or the pieces (Each lines).
- `app/buyer/portal/[seller]/shop/_components/QtyStepper.tsx` counts Cases by default with a Case/Each toggle (Case disabled while loose pieces exist); used by `ProductTile`, `RunningLowStrip`, `DetailActions`, `favorites/page.tsx` (shared 44px control), `shelf/page.tsx` (qty derived from box count), `cart/page.tsx`, `_components/CartRowQty.tsx`, `CartLineUnit.tsx`. `lib/generic-toast-copy.ts` maps `QTY_SPLIT_MISMATCH`.

## #3472 product detail: reach the action (Batch A)

- `app/(dashboard)/products/[id]/`: `ProductHeaderLine.tsx` (NEW, `SKU · Category · N in stock`), `ProductEditActions.tsx` (word buttons, sticky Save/Cancel bar below `md`), `ProductInsightsExport.tsx` (NEW `{productId, sku}`; hidden while loading or never sold), `useReactivateFlow.tsx` (NEW hook, `ProductKind`), `ProductStockCostCard.tsx` (stock status only in the header badge; Unassigned row removed; caption "Not yet split to variants" on a generic with variants), `ProductHeaderControls.tsx`, `page.tsx`.
- `components/ConfirmDialog.tsx` gains `variant="warning"` (amber; Deactivate/Reactivate). App-wide: the default `danger` variant now focuses Cancel first. `components/family/FamilyVariantsEditor.tsx` toast names added/changed counts. The image-card reorder pair stays.

## #3460 hiding from all portal customers is admin-only (L5)

- `lib/portal-hide-admin.ts` (NEW) `mayHideFromAllPortal(role)`, `hidesFromAllPortalCustomers(rule)` (FEDERAL only), `ASK_ACCOUNT_ADMIN`. `components/portal-limits/LimitInPortalDialog.tsx` disables the all-customers choice for non-admins; `app/(dashboard)/settings/restrictions/rules/page.tsx` disables an operator's tick on a FEDERAL rule. No api change (the rule writers already 403).

## #3474 repeat scans no longer undercount (row 536, P0)

- `app/(dashboard)/orders/_components/scan/serial-scan-queue.ts` (NEW) `createSerialScanQueue(run)`: wedge, typed and single-shot scans run FIFO, one at a time. `useScanCodeHandler.ts`: a code already on the order resolves from the order (no lookup; map cleared per order), event-time (`e.timeStamp`) wedge detector, field cleared at take time. `ScanOrderScreen.tsx` shows the rejected cue and a line on a `dropped` scan; `CreateOrderModal.tsx`, `components/BarcodeScannerButton.tsx`, `lib/default-unit-line.ts` (N taps onto a derived base unit = N pieces). Engine: `packages.md`.

## #3473 train S3, web side

- `lib/edit-line-derived-unit.ts` (NEW) `derivedUnitPatch(...)`, `DerivedEditLine`; `lib/order-line-unit.ts`, `unit-options.ts`, `components/OrderLineUnitPicker.tsx`: derived-unit edit lines. `lib/product-tier-patch.ts` (NEW) `TIER_PRICE_KEYS`, `editTierPatch`, `editTierPatchMoves`. `lib/kept-labels-copy.ts` (NEW) `keptLabelsNote`, `keptLabelsNoteForBulk`. `lib/estimate-tax-basis.ts` (NEW) wraps `estimateTaxBasisNotice`. Stock count: `components/inventory/StockCountTab.tsx`, `StockCountReviewModal.tsx`, `lib/api/stock-count.ts` (partly-saved, finish-with-skips and recount copy from `@routeflow/types`). Also `lib/product-reactivation-refusal.ts`, `lib/portal-limits.ts`, `lib/api/products.ts`, `components/GroupAsVariantsModal.tsx`, `MoneyInput.tsx`.
