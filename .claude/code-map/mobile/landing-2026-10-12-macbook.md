# Mobile landing 2026-10-12 (MacBook lane pushed branches)

Pushed, not yet merged. Symbols read at the branch tip. Paths are under `apps/mobile/`. Tests are not indexed.

## POS mode, mobile (`feat/pos-mode-p2-mobile`, `420ee6c6d`)

- NEW `lib/pos-mode.ts` (pure logic): `POS_MODE_PREF_KEY` (the shared `PREF.ordersPosMode`), `canUsePosMode(role)`, `posModeFromPreferences`, `posModePrefPatch`, `POS_COPY`, `posProgressSteps`, `posOrderActions`, `posFinishFailureMessage`, `pendingRefusalIsDone`, `posConfirmSteps` / `posConfirmStepsAfterPending` (DRAFT is promoted to PENDING first), `posBalanceDue`, `posHandOverBalance(input) -> PosHandOverBalance` (a balance read that is loading or errored yields an unknown state, never the gross total), `posMayHandOverUnpaid`, `planPosTender`, `POS_TENDER_METHODS`, `decidePickupResponse(res) -> PickupDecision`, `pickupCompleteErrorCopy`.
- NEW `lib/api/pos-orders.ts`: `usePosModePreference`, `PosFinishError`, `usePosFinish`, `usePickupComplete(orderId)`, `releasePickupKey`, `useSwitchOrderToDelivery`, `usePickupInvoiceBalances(invoiceIds, enabled)` (the server's invoice balances for the hand-over). NEW `lib/use-pos-mode.ts` `usePosModeState(enabled)`.
- `lib/order-status-flow.ts`: `isPosOrder(order)` (PICKUP and not counter sale, the web predicate), `POS_HIDDEN_TARGET_STATUSES`, `posStatusMoveAllowed`. `lib/order-actions.ts` hides generic status moves on a POS order.
- NEW `components/PosHandOverSheet.tsx` `PosHandOverSheet` (tender, cash change via the shared `fmtCurrency`, submit disabled while balances are loading or errored), `components/PosModeSwitch.tsx` `PosModeSwitch`, `PosConfirmOnly`; `components/new-order/CartModal.tsx` and `NewOrderScreen.tsx` show the switch and the POS save labels; `components/new-order/CatalogParts.tsx` `RowSpacer`, `CatalogSectionLabel`; `new-order/types.ts` +POS fields; `app/(operator)/(tabs)/orders/[id].tsx` POS progress and hand-over.
