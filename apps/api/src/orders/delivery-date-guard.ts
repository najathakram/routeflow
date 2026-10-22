import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  calendarDateFromIso,
  calendarStampFromInput,
  startOfCalendarDay,
} from "../common/calendar-date";
import { tenantTimeZone } from "../common/tenant-time-zone";

/**
 * Row 718 — the server half of the Create Order modal's "That day has passed" check (#3580 only blocks
 * it in the browser, on the browser's own day). A requested delivery day BEFORE the tenant's today is
 * refused with a coded 400; today and later pass.
 *
 * "Today" is the TENANT's calendar day in its own zone (`tenantTimeZone`, UTC when it has none, the
 * `calendar-date.ts` contract), never the server's or the caller's: a buyer in another zone or a
 * browser on a different day than the business is judged on the business's day.
 *
 * WHO is held to it (pinned by `delivery-date-guard.callsites.pin.spec.ts`): the USER-facing writers
 * only — `OrdersService.create()` (staff, driver and buyer creates, the sale and counter-sale paths
 * that run through it) and the buyer cart merge in `BuyerController.createOrder`. System writers (the
 * standing-order generator, the buyer merge header write that runs after the controller's check, the
 * change-request rollover draft) do not call it and keep writing whatever date they compute.
 *
 * On a CHANGE of an existing date (`opts.existing`) only a date that moves to a different past day is
 * refused: an order whose date has since passed stays editable when the date is not part of the change
 * or is resent as it is.
 */

/** What the guard reads: the ambient tenant id and the tenant's `TenantConfig.timezone`. */
type GuardPrisma = Parameters<typeof tenantTimeZone>[0];

export interface DeliveryDateGuardOptions {
  /** The tenant to judge on; the ambient tenant of `prisma` when absent (e.g. a SUPER_ADMIN token has none). */
  tenantId?: string | null;
  /** The date the order carries now: sending it back unchanged is not a change. */
  existing?: Date | string | null;
  /** The instant "now" is measured at (tests); the wall clock by default. */
  now?: Date;
}

/** The tenant's calendar day (YYYY-MM-DD) at `now` in `zone` (UTC when the zone is null). */
export function tenantTodayDay(zone: string | null | undefined, now: Date = new Date()): string {
  return calendarDateFromIso(startOfCalendarDay(now, zone));
}

/** The calendar day a stored or sent date names: a sent string by its literal first ten characters (the house rule), a stored instant by its UTC day. */
function dayOf(value: Date | string): string {
  return typeof value === "string" ? value.slice(0, 10) : calendarDateFromIso(value);
}

/**
 * 400 `DELIVERY_DATE_IN_PAST` when `raw` names a day before the tenant's today (and is not the
 * `existing` date resent as it is); resolves otherwise. A missing or non-calendar value is not judged
 * here: the DTO and the writer own those.
 */
export async function assertDeliveryDateNotPast(
  prisma: GuardPrisma,
  raw: string | null | undefined,
  opts: DeliveryDateGuardOptions = {},
): Promise<void> {
  if (!raw) return;
  if (!calendarStampFromInput(raw)) return;
  const day = raw.slice(0, 10);
  if (opts.existing && dayOf(opts.existing) === day) return;
  const zone = await tenantTimeZone(prisma, { tenantId: opts.tenantId });
  const today = tenantTodayDay(zone, opts.now);
  if (day >= today) return;
  throw new BadRequestException({
    code: API_ERROR_CODES.DELIVERY_DATE_IN_PAST,
    message: `That day has passed (today is ${today} for this business). Pick today or a later date.`,
    requestedDeliveryDate: day,
    today,
  });
}
