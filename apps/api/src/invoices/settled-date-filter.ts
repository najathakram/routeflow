import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * Post-dated check payments — collected-basis window on InvoicePayment (M2):
 * the settled (bank) date when one is recorded, otherwise the recorded
 * payment date — legacy rows carry no `settledAt` and therefore keep
 * reporting on `paidAt`. Mirrors `@routeflow/pricing`'s `collectedDateOf`
 * (JS-side coalesce) for the Prisma `where`-clause side, which can't live in
 * `@routeflow/pricing` itself (that package stays Prisma-free).
 *
 * Accepts any subset of `gte`/`lte`/`lt`/`gt` so a caller can express either
 * an inclusive `[from, to]` window (the bookkeeping dashboards' convention)
 * or a half-open `[from, to)` one (the buyer statement's month range) with
 * the same helper — never two competing date-window shapes for the same
 * "was this collected in this period" question.
 */
export interface DateRange {
  gte?: Date;
  lte?: Date;
  lt?: Date;
  gt?: Date;
}

export function settledDateFilter(range: DateRange): Prisma.InvoicePaymentWhereInput {
  return {
    OR: [{ settledAt: { ...range } }, { settledAt: null, paidAt: { ...range } }],
  };
}

/**
 * Normalise a date query param to the `YYYY-MM-DD` calendar day it names,
 * BEFORE it is concatenated into a literal instant (`${day}T23:59:59.999Z`).
 * The list DTOs accept `@IsDateString()`/`@IsString()`, so a full ISO-8601
 * datetime is a valid input — concatenating one raw would yield an
 * `Invalid Date` bound that silently reaches Prisma. An unparsable value is
 * rejected here with a 400 instead of becoming a broken filter.
 */
export function calendarDayOf(raw: string, field: string): string {
  const day = raw.slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    Number.isNaN(new Date(`${day}T00:00:00.000Z`).getTime())
  ) {
    throw new BadRequestException(`${field} must be a calendar date (YYYY-MM-DD)`);
  }
  return day;
}
