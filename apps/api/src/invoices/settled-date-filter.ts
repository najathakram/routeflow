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
