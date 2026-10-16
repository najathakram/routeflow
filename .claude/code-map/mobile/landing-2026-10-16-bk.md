# Mobile landing 2026-10-16

Range `96fc7351f..b6ed040dc`, mobile side. Paths under `apps/mobile/`. Tests not indexed.

- #3471: `lib/buyer-qty-split.ts` (NEW) `isQtySplitMismatch(err)`, `reorderErrorCopy(err)`, `BUYER_QTY_SPLIT_MISMATCH_COPY`, `BUYER_REORDER_PACK_CHANGED_COPY`; `app/(customer)/orders/cart.tsx` and `[id].tsx` use them (a reorder after a pack-size change tells the buyer to add from the catalog). The mobile cart never had the drift; invariant pins only.
- #3474: no mobile source change; `__tests__/scan-engine.test.ts` and `scan-camera-buffer.test.ts` pin that mobile keeps the 09-24 repeat rule (no `fastRepeat`).
- #3473: `lib/fulfilment-caps.ts` (NEW) `fulfilmentCapsFrom(features)`, `staffFormFulfilment(features)`, `FormFulfilPath`; `lib/estimate-tax-basis.ts` (NEW, wraps the `@routeflow/types` notice); `lib/stock-count-logic.ts`, `stock-count-autosave.ts`, `lib/api/stock-count.ts` for the batched commit; unit chain in `lib/unit-options.ts`, `default-unit-line.ts`, `cart-line-state.ts`, `components/UnitPickerRow.tsx`, `CartRow.tsx`.
