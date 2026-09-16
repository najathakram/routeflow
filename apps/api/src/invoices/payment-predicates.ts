/**
 * Thin API-local re-export of `@routeflow/pricing`'s payment-confirmation
 * predicate (F03/B421) — kept so every existing `from "./payment-predicates"`
 * call site in this module didn't need to change import paths when the logic
 * moved to the shared package (money discipline: api/web/mobile all import
 * the ONE copy, never a mirror — see `@routeflow/pricing/src/payment-confirmation.ts`
 * for the full doc, the design rationale, and lesson L-159).
 */
export {
  ADVANCE_METHOD,
  CASH_METHOD_FILTER,
  CONFIRMED_PAYMENT,
  CONFIRMED_STATUS,
  CREDIT_NOTE_METHOD,
  RECEIVED_METHOD_FILTER,
  resolveConfirmedAmounts,
  splitConfirmed,
  sumConfirmed,
  // Post-dated check payments PR-1 (additive-only) — see
  // @routeflow/pricing/src/payment-confirmation.ts for the full doc, N4's binding citation, and
  // why `remainingCapacity` deliberately does NOT reuse `sumHeld`/`sumConfirmed`.
  HELD_STATUSES,
  HELD_PAYMENT,
  isHeldPayment,
  sumHeld,
  collectedDateOf,
  remainingCapacity,
} from "@routeflow/pricing";
export type {
  ConfirmablePaymentRow,
  PrecomputedConfirmedAmounts,
  SplitConfirmedResult,
} from "@routeflow/pricing";
