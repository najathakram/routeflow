import { roundMoney } from "@routeflow/pricing";

/**
 * Subscription money math (Plans & Billing). This is a BILLING-only concern —
 * server-authoritative; the web/mobile clients render the Decimal strings the API
 * returns, so these helpers deliberately live here (not in the shared line-item
 * `pricing.ts`, which the three app mirrors keep in sync). Every result is routed
 * through {@link roundMoney} for cent discipline.
 *
 * Anchors (catalog v8 — plan-catalog.constants.ts PLAN_KEYS; the live prices live
 * in the database PlanDefinition rows, these are documentation only):
 *   Starter $99/mo  → $990/yr  → "$83/mo billed annually"
 *   Growth  $249/mo → $2490/yr → "$208/mo billed annually"
 *   Scale   $499/mo → $4990/yr → "$416/mo billed annually"
 *   Enterprise: custom (no anchor)
 */

export type Cycle = "MONTHLY" | "ANNUAL";

/** Annual price = 10 months (2 months free). ×10 is exact for a 2-dp monthly price. */
export function annualPrice(monthly: number): number {
  return roundMoney(monthly * 10);
}

/**
 * The "$X/mo billed annually" DISPLAY figure — WHOLE dollars, round-half-away
 * (matches pricing.html exactly: 59→49, 149→124, 349→291). This is a marketing
 * display only; the amount actually charged is {@link annualPrice}, never this.
 */
export function annualEffectivePerMo(monthly: number): number {
  const perMo = (monthly * 10) / 12;
  const sign = perMo < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(perMo));
}

/** Annual saving vs paying monthly for a year = 2 months. */
export function annualSaving(monthly: number): number {
  return roundMoney(monthly * 2);
}

/** The billed price for one line at a given cycle. */
export function cyclePrice(monthly: number, cycle: Cycle): number {
  return cycle === "ANNUAL" ? annualPrice(monthly) : roundMoney(monthly);
}

/**
 * Daily proration: the charge for the REMAINING days of the current cycle when a
 * line is added mid-cycle. `roundMoney(monthly × daysRemaining / daysInCycle)`.
 * daysRemaining is clamped to [0, daysInCycle]; a non-positive cycle yields 0.
 *
 * Reference (30-day cycle, 16 days remaining): SEAT $12→$6.40, ROUTE $15→$8.00,
 * REGULATED $39→$20.80.
 */
export function prorateDaily(monthly: number, daysRemaining: number, daysInCycle: number): number {
  if (!(daysInCycle > 0)) return 0;
  const d = Math.max(0, Math.min(daysRemaining, daysInCycle));
  return roundMoney((monthly * d) / daysInCycle);
}

/** Whole-day count between two instants (UTC), never negative. */
export function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/**
 * Add whole months (or, via {@link addCycle}, a year) to a UTC date, clamping the
 * day to the target month's length (Jan 31 + 1mo → Feb 28/29, never overflowing
 * into March) and preserving `from`'s time-of-day (hours/minutes/seconds/ms)
 * exactly — a rolled period boundary must not collapse to midnight.
 *
 * `anchorDay`, when given, is the tenant's ORIGINAL, never-clamped billing anchor
 * day (1-31) to clamp toward. Pass it explicitly whenever chaining calls across
 * cycles (a nightly roll, one call per tick) so a short month's clip does not
 * permanently ratchet the anchor down — `from.getUTCDate()` alone re-derives the
 * day from the PREVIOUS (already-clamped) result, which is exactly the B329 bug:
 * a 31st anchor clipped to 28 in February then stayed on 28 forever after, even in
 * a 31-day month. Omitting `anchorDay` uses `from`'s own day, correct for a single,
 * non-repeating add (e.g. `subscribe()` computing one period end from "now").
 */
export function addMonthsUtc(from: Date, months: number, anchorDay?: number): Date {
  const day = anchorDay ?? from.getUTCDate();
  const d = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth() + months,
      1,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** One cycle's worth of {@link addMonthsUtc} — 12 months for ANNUAL, 1 otherwise.
 *  `cycle` is typed as `string` (rather than the narrower {@link Cycle}) so both the
 *  plans-as-data `Cycle` literal and Prisma's generated `BillingCycle` enum widen
 *  into it without a cast at either call site. See {@link addMonthsUtc} for
 *  `anchorDay`. */
export function addCycle(from: Date, cycle: string, anchorDay?: number): Date {
  return addMonthsUtc(from, cycle === "ANNUAL" ? 12 : 1, anchorDay);
}
