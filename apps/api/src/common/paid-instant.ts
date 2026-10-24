import { BadRequestException } from "@nestjs/common";
import { parseCalendarDay, startOfLocalDay, tenantTodayDay } from "./calendar-date";

/**
 * SA-943 PR-A (W-765): THE write seam for a paid / settled / received date on an INSTANT column (`paidAt`, `settledAt`,
 * `receivedAt`). Every such DTO field is `@IsDateString()`, which takes both a date-only "YYYY-MM-DD" and a full ISO
 * instant; `new Date("2026-10-24")` is 00:00Z, the previous evening for every tenant west of UTC. So:
 *  - a date-only value equal to the tenant-local TODAY is the real instant "now" (a same-day record after a close is
 *    never dated into yesterday's closed window);
 *  - any other date-only value is the tenant-local start of the named day (SA-906's rule), DST-safe via calendar-date.ts;
 *  - a full ISO instant is stored as given; a blank value is "now".
 * The zone comes from `tenantTimeZone`, resolved once per request (null = the UTC fallback). Calendar columns
 * (`Expense.date`, invoice issue / due dates) are NOT instants and never come through here. Pinned by
 * `paid-instant-writers.inventory.spec.ts`.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

type PaidInput = string | Date | null | undefined;

/** True for a "YYYY-MM-DD" value (the shape the date box sends). */
export function isDateOnly(input: PaidInput): input is string {
  return typeof input === "string" && DATE_ONLY.test(input.trim());
}

/**
 * The instant a paid-date input names, or null for "now" (blank, or a date-only tenant-local today): the caller picks
 * its own clock for null (the counter guard uses the DATABASE clock its close cutoff is read from).
 */
export function givenPaidInstant(
  input: PaidInput,
  zone: string | null | undefined,
  now: Date = new Date(),
  field = "paidAt",
): Date | null {
  if (input === null || input === undefined || input === "") return null;
  if (input instanceof Date) return input;
  const raw = input.trim();
  if (!DATE_ONLY.test(raw)) return new Date(raw);
  if (!parseCalendarDay(raw))
    throw new BadRequestException(`${field} must be a real calendar date`);
  if (raw === tenantTodayDay(zone, now)) return null;
  return startOfLocalDay(raw, zone);
}

/** `givenPaidInstant`, with "now" filled in from `now`. */
export function paidInstantOf(
  input: PaidInput,
  zone: string | null | undefined,
  now: Date = new Date(),
  field = "paidAt",
): Date {
  return givenPaidInstant(input, zone, now, field) ?? now;
}

/**
 * An EDIT never re-stamps (SA-943 MUST 2): a date-only value equal to the tenant-local date of the STORED instant keeps
 * the stored instant (the edit form resends the date it shows), so editing only a reference leaves the real time alone.
 * Anything else is `paidInstantOf`.
 */
export function keptPaidInstantOf(
  input: PaidInput,
  stored: Date | null | undefined,
  zone: string | null | undefined,
  now: Date = new Date(),
  field = "paidAt",
): Date {
  return keptGivenPaidInstant(input, stored, zone, now, field) ?? now;
}

/**
 * `keptPaidInstantOf` that leaves "now" to the caller (null), like `givenPaidInstant`: an edit to the tenant-local
 * today takes the caller's clock (invoices `updatePayment` reads the DATABASE clock).
 */
export function keptGivenPaidInstant(
  input: PaidInput,
  stored: Date | null | undefined,
  zone: string | null | undefined,
  now: Date = new Date(),
  field = "paidAt",
): Date | null {
  if (stored && isDateOnly(input) && input.trim() === tenantTodayDay(zone, stored)) return stored;
  return givenPaidInstant(input, zone, now, field);
}
