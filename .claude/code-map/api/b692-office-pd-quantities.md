# API B692 office PARTIALLY_DELIVERED quantities (SA-814 R4-3)

Paths under `apps/api/src/orders/`. Manual `PARTIALLY_DELIVERED` needs per-line `deliveries[]` (or existing delivery data), else 409 `ORDER_PD_NEEDS_QUANTITIES`; the cancel fails closed on legacy delivered rows (409 `ORDER_DELIVERY_QUANTITIES_MISSING`).

- `order-pd-quantities.ts` (NEW): `deliveryQuantitiesMissing(db, orderId)` is the ONE predicate (active lines all `deliveredQty` 0 and no evidence row; REFUSED row counts); `recordPartialDeliveryInTx(tx, orderId, deliveries?)` writes DeliveryMutation rows (`PARTIAL`/`DELIVERED`, `note` OFFICE_MARKED, no stop/driver), recomputes `deliveredQty` via `deliveredQtyRecompute`, then refuses when still missing; `cancelBlockedByMissingQuantities`, `throwDeliveryQuantitiesMissing`.
- `order-ship-state.ts` `updateStatusWithShipMarker` takes `deliveries?` on its status arg: PD runs `recordPartialDeliveryInTx` in the SAME tx as the status CAS (plain and ship-marker paths; the refusal rolls the status and marker back).
- `order-cancel-impact.ts` `cancelImpact` adds `deliveryQuantitiesMissing` (DELIVERED / PARTIALLY_DELIVERED only) and `canCancel` false; `assertQuantitiesKnown(impact)` is called from `OrdersService.assertCancellableOrThrow` after the payments check. Counter-sale void bypasses it (uses `cancelOrderInTx` directly).
- `dto/change-order-status.dto.ts`: `deliveries?: OfficeDeliveryLineDto[]` (`orderItemId`, `quantityDelivered` >= 0, `note?`). Codes: `common/api-error-codes.ts` + `packages/types/api/error-codes.ts`.
- Clients: mobile `lib/order-actions.ts` no longer offers "Partial delivery" (web has no manual PD control); `cancel-impact.ts` (web, mobile) explains the new refusal. Specs: `b692-office-pd-quantities.spec.ts`, `.db.spec.ts`.
