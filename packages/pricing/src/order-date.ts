// ─── The sale's business date (W-1188, SA ruling 2026-11-09): caps and the "dated" drift ─────────────────────────────
//
// `Order.orderDate` is the business day a sale counts on; `createdAt` is the instant it was entered. The API's one gate
// (`resolveOrderDate`, apps/api/src/orders/order-date.ts) judges a typed day against `orderDateRange`; the Today's sales
// tag, the order detail line, the receipt and the audit row all read `orderDateDrift`. Days are YYYY-MM-DD strings on the
// TENANT's calendar (the zone is a parameter, UTC when null or unknown), never instants.
//
// The two caps are owner question Q1 (typo guards: "2062" for "2026"): ONE line each to change.

export const ORDER_DATE_MAX_PAST_YEARS = 2;
export const ORDER_DATE_MAX_FUTURE_DAYS = 366;

export const ORDER_DATE_POLICY_VALUES = ["COUNTER", "OFFICE"] as const;
export type OrderDatePolicy = (typeof ORDER_DATE_POLICY_VALUES)[number];

export const ORDER_DATE_DIRECTION_VALUES = ["BACK", "FORWARD"] as const;
export type OrderDateDirection = (typeof ORDER_DATE_DIRECTION_VALUES)[number];

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar day (YYYY-MM-DD) an instant falls on in `zone`; UTC for a null or unknown zone. */
export function tenantDayOf(instant: Date, zone?: string | null): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const at = (t: string) => parts.find((p) => p.type === t)?.value;
    return `${at("year")}-${at("month")}-${at("day")}`;
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/** True when `day` names a real calendar day ("2026-02-31" does not). */
export function isRealDay(day: string): boolean {
  const m = DAY.exec(day);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** `day` plus `days` calendar days (negative goes back). */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** `day` minus `years`, a Feb 29 landing on Feb 28 when the target year has none. */
function minusYears(day: string, years: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const target = new Date(Date.UTC(y - years, m - 1, d));
  if (target.getUTCMonth() !== m - 1)
    return new Date(Date.UTC(y - years, m - 1, 0)).toISOString().slice(0, 10);
  return target.toISOString().slice(0, 10);
}

/**
 * The days a policy accepts, given the tenant's today. OFFICE: back to the floor, no day after today. COUNTER: the same
 * floor, and up to `ORDER_DATE_MAX_FUTURE_DAYS` ahead. Both ends are inclusive.
 */
export function orderDateRange(
  today: string,
  policy: OrderDatePolicy,
): { min: string; max: string } {
  return {
    min: minusYears(today, ORDER_DATE_MAX_PAST_YEARS),
    max: policy === "COUNTER" ? addDays(today, ORDER_DATE_MAX_FUTURE_DAYS) : today,
  };
}

export interface OrderDateDrift {
  /** The chosen business day. */
  day: string;
  /** The tenant day the sale was entered. */
  enteredDay: string;
  direction: OrderDateDirection;
  /** Signed days from the entry day to the chosen day (negative = back). */
  days: number;
}

/**
 * How far a sale's business date sits from the day it was entered, on the tenant's calendar. `null` when there is no
 * date, or it is the entry day itself (not "dated"). The ONE reader: the Today's sales tag, the order detail, the
 * receipt and the audit row all call it.
 */
export function orderDateDrift(
  orderDate: Date | string | null | undefined,
  createdAt: Date | string,
  zone?: string | null,
): OrderDateDrift | null {
  if (orderDate == null) return null;
  const chosen = (typeof orderDate === "string" ? new Date(orderDate) : orderDate)
    .toISOString()
    .slice(0, 10);
  const entered = tenantDayOf(
    typeof createdAt === "string" ? new Date(createdAt) : createdAt,
    zone,
  );
  const days = daysBetween(entered, chosen);
  if (days === 0) return null;
  return {
    day: chosen,
    enteredDay: entered,
    direction: days < 0 ? "BACK" : "FORWARD",
    days,
  };
}
