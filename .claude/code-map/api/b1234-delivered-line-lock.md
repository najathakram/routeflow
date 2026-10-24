# B1234 — delivered lines are locked on a PARTIALLY_DELIVERED order (branch, pre-landing)

- `apps/api/src/orders/delivered-line-lock.ts` — pure guard. `DELIVERED_LOCK_STATUSES` (PARTIALLY_DELIVERED), `deliveredLockApplies(status)`, `isDeliveredLine(line)` (deliveredQty > 0), `assertDeliveredLinesUntouched(...)`: replace modes fail closed; diff mode refuses qty / unit / product / price / cancel / delete / substitute on a delivered line, allows a note. Throws 409 `LINE_ALREADY_DELIVERED` (the same code as the at-door change request, SA-814; no new code).
- `orders.service.ts` `updateOrderItems` — pre-tx call is a fast-fail only; the BINDING call runs on the locked `heldItems` after `lockOrderRow` and reads the status under the lock.
- web `orders/[id]/_components/DeliveredLineLock.tsx` + `EditableLineItems` — a delivered line hides qty, unit, Not-available and substitute controls and shows the hint; `useUpdateOrderItems` opts the staff save into the `LINE_ALREADY_DELIVERED` toast (`meta.lineDeliveredToast`).
- Specs: `orders.delivered-line-lock.spec.ts` (unit, incl. stale-read under the lock), `b1234-delivered-line-lock.db.spec.ts`.
