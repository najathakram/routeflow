import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { startOfCalendarDay } from "../common/calendar-date";

/**
 * Resolve the staff-supplied business date of an order. A bare "YYYY-MM-DD"
 * parses to midnight UTC, matching how requestedDeliveryDate/issueDate are handled.
 * The upper bound is the END of the current UTC day so an operator in a timezone
 * ahead of UTC can still enter today. A caller that knows the tenant's zone (`opts.zone`) also lets the TENANT's own
 * today through when that day has already begun there but not yet in UTC (Row 735b: the sale's delivered-on day).
 */
export function parseOrderDate(
  raw: string | undefined,
  role: UserRole,
  opts: { zone?: string | null; now?: Date } = {},
): Date | undefined {
  if (raw == null) return undefined;
  // POST /orders is reachable by CUSTOMER and DRIVER — only staff may backdate.
  if (role !== UserRole.OPERATOR && role !== UserRole.TENANT_ADMIN) {
    throw new ForbiddenException("Only staff can set an order date");
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException("Invalid order date");

  const now = opts.now ?? new Date();
  const utcEndOfToday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    23,
    59,
    59,
    999,
  );
  const tenantEndOfToday = opts.zone
    ? startOfCalendarDay(now, opts.zone).getTime() + 86_400_000 - 1 // the tenant's day, as a UTC-midnight stamp's last ms
    : utcEndOfToday;
  const endOfToday = Math.max(utcEndOfToday, tenantEndOfToday);
  if (parsed.getTime() > endOfToday) {
    throw new BadRequestException("Order date cannot be in the future");
  }
  const earliest = new Date(now);
  earliest.setUTCFullYear(earliest.getUTCFullYear() - 2);
  if (parsed.getTime() < earliest.getTime()) {
    throw new BadRequestException("Order date cannot be more than 2 years in the past");
  }
  return parsed;
}

/**
 * Sales agents & commissions: staff-only per-order commission-rate override.
 * `0` IS a valid value ("exempt"); `undefined` means "no override given"
 * (falls back to customer/agent default rates). Gated exactly like
 * parseOrderDate — CUSTOMER/DRIVER callers may never set this.
 */
export function parseCommissionRatePct(
  raw: number | null | undefined,
  role: UserRole,
): number | null | undefined {
  if (raw === undefined) return undefined;
  if (role !== UserRole.OPERATOR && role !== UserRole.TENANT_ADMIN) {
    throw new ForbiddenException("Only staff can set a commission rate");
  }
  if (raw === null) return null;
  if (typeof raw !== "number" || Number.isNaN(raw) || raw < 0 || raw > 100) {
    throw new BadRequestException("commissionRatePct must be between 0 and 100");
  }
  return raw;
}
