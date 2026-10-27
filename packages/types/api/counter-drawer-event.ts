// ─── Counter drawer events (W-819, SA-930 section 4): the opening float, counted at open and locked ─────────────────────
//
// Routes (all under /api/v1/orders/counter-sale/drawer/opening-float):
//   GET   ?registerKey&windowStart  -> OpeningFloatState   (OPERATOR + till permission; TENANT_ADMIN passes)
//   POST  body RecordOpeningFloatRequest -> RecordOpeningFloatResult (OPERATOR + till permission)
//   PATCH body CorrectOpeningFloatRequest -> CounterDrawerEventView (TENANT_ADMIN only; reason required; audited)
// `windowStart` is the key the day close uses: DayCloseState.preview.windowStart (an ISO instant).

import type { CounterDrawerEventKind } from "./enums";
import type { DenominationCount } from "./counter-day-close";

export interface CounterDrawerEventView {
  id: string;
  registerKey: string;
  /** ISO instant, the day close's window key */
  windowStart: string;
  kind: CounterDrawerEventKind;
  /** whole-cents money, 0..1,000,000 */
  amount: number;
  /** the counted bills and coins when the till sent them; null when only a total was typed (or after a correction without them) */
  denominations: DenominationCount[] | null;
  /** when it was counted (ISO) */
  at: string;
  byId: string;
  /** "Counted at open by {byName}, {at}": the counter's display name, null if the user was removed */
  byName: string | null;
  /** the reason of the latest admin correction; null while never corrected */
  reason: string | null;
}

export interface OpeningFloatState {
  registerKey: string;
  windowStart: string;
  /** null until the drawer was counted for this window */
  event: CounterDrawerEventView | null;
}

export interface RecordOpeningFloatRequest {
  /** ISO instant, DayCloseState.preview.windowStart; anything but the register's open window is 409 COUNTER_FLOAT_WINDOW_NOT_OPEN */
  windowStart: string;
  amount: number;
  /** optional; when sent, its sum must equal `amount` */
  denominations?: DenominationCount[];
  registerKey?: string;
}

export interface RecordOpeningFloatResult {
  event: CounterDrawerEventView;
  /** false when the window already held this exact amount (an idempotent replay); a different amount is 409 COUNTER_FLOAT_ALREADY_COUNTED */
  created: boolean;
}

export interface CorrectOpeningFloatRequest {
  /** the window the float was counted for; it must still be the register's open window, so after a close the day must be reopened first (else 409 COUNTER_FLOAT_WINDOW_NOT_OPEN) */
  windowStart: string;
  /** the corrected amount; must differ from the current one unless a new breakdown is sent */
  amount: number;
  /** required: the amount the screen showed. If the stored amount is no longer this, 409 COUNTER_FLOAT_CHANGED and nothing is written */
  expectedAmount: number;
  /** 5..500 characters, required */
  reason: string;
  /** optional; when sent, its sum must equal `amount`; when omitted the old breakdown is dropped */
  denominations?: DenominationCount[];
  registerKey?: string;
}
