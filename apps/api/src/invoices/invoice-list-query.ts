import { InvoiceStatus } from "@prisma/client";
import type { ListInvoicesDto } from "./dto/list-invoices.dto";
import { calendarDayOf } from "./settled-date-filter";
import { overdueCutoff } from "../common/calendar-date";

/**
 * The invoice LIST query, lifted verbatim out of `InvoicesService.findAll` (size-ratchet prefactor for
 * F-05, #2093): pure filter / sort building, no Prisma call. The buyer scoping between the two filter
 * stages stays in the service (it needs the customer lookup) and still runs in the original order.
 */

/** Status / overdue / shipments filters: the first stage, before the buyer scoping. */
export function applyInvoiceStatusFilters(
  where: any,
  query: ListInvoicesDto,
  timeZone?: string | null,
): void {
  const { status, statuses, isOverdue, shipped } = query;
  // Shipments view: only invoices that carry a carrier tracking number.
  if (shipped) where.shippingTrackingNumber = { not: null };
  if (isOverdue) {
    // Derived overdue: unpaid invoices past the END of their due day in the tenant's zone
    // (SA-488: the same rule as the cron, recomputeStatus and bookkeeping aging).
    where.status = {
      in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.PARTIAL, InvoiceStatus.OVERDUE],
    };
    where.dueDate = { lt: overdueCutoff(new Date(), timeZone) };
  } else if (statuses && statuses.length > 0) {
    // RF-204: normalize legacy "VOIDED" alias → the DB enum value "VOID"
    where.status = { in: statuses.map((s: string) => (s === "VOIDED" ? "VOID" : s)) };
  } else if (status) {
    // RF-204: normalize "VOIDED" → "VOID" for single-status filter
    where.status = (status as string) === "VOIDED" ? "VOID" : status;
  }
}

/** Search / issue-date / due-date filters: the second stage, after the buyer scoping. */
export function applyInvoiceSearchAndDateFilters(where: any, query: ListInvoicesDto): void {
  const { search, dateFrom, dateTo, dueFrom, dueTo } = query;
  if (search) {
    where.OR = [
      { customer: { businessName: { contains: search, mode: "insensitive" } } },
      { invoiceNumber: { contains: search, mode: "insensitive" } },
      { shippingTrackingNumber: { contains: search, mode: "insensitive" } },
    ];
  }
  if (dateFrom || dateTo) {
    where.issueDate = {};
    if (dateFrom)
      where.issueDate.gte = new Date(`${calendarDayOf(dateFrom, "dateFrom")}T00:00:00.000Z`);
    // B89/L-047: issueDate is a UTC-midnight calendar stamp, so its day-end
    // bound is the LITERAL UTC instant of the date string — never a
    // host-local `setHours` mutation, which silently disagrees with the
    // UTC-midnight convention off a UTC host.
    if (dateTo) where.issueDate.lte = new Date(`${calendarDayOf(dateTo, "dateTo")}T23:59:59.999Z`);
  }
  // Due-soon window (Due today / Due tomorrow / Next 7 days chips). MERGE into any
  // dueDate clause `isOverdue` already set — the two intersect, they don't override
  // each other. `dueTo` widens to end-of-day like `dateTo`, otherwise a date-only
  // value truncates to midnight and drops invoices due later that same day.
  if (dueFrom || dueTo) {
    where.dueDate = { ...(where.dueDate ?? {}) };
    if (dueFrom) where.dueDate.gte = new Date(`${calendarDayOf(dueFrom, "dueFrom")}T00:00:00.000Z`);
    // B89/L-047: dueDate is also a UTC-midnight calendar stamp — same literal
    // UTC instant convention as issueDate above.
    if (dueTo) where.dueDate.lte = new Date(`${calendarDayOf(dueTo, "dueTo")}T23:59:59.999Z`);
  }
}

/** The list's `orderBy` from the `sortBy` / `sortOrder` params. */
export function invoiceListOrderBy(sortBy?: string, sortOrder?: string): any {
  const validSortFields: Record<string, string> = {
    date: "issueDate",
    issueDate: "issueDate",
    dueDate: "dueDate",
    total: "total",
    amount: "total",
    createdAt: "createdAt",
    status: "status",
    invoiceNumber: "invoiceNumber",
  };
  // m9: Object.hasOwn (not a bare index) so prototype keys — `constructor`,
  // `__proto__`, `toString`, `valueOf`… — can't resolve to an INHERITED value
  // and reach Prisma as a malformed orderBy (→ 500). Unknown OR inherited
  // falls back to the safe issueDate default.
  const orderField =
    sortBy && Object.hasOwn(validSortFields, sortBy) ? validSortFields[sortBy] : "issueDate";
  const orderDir = sortOrder === "asc" ? "asc" : "desc";
  // B169: `id` tiebreaker — issueDate/createdAt ties are STRUCTURAL (bulk
  // imports, UTC-midnight stamps sharing a value), so a single-key orderBy
  // leaves page order unstable across identical requests.
  return [{ [orderField]: orderDir }, { id: orderDir }];
}
