// All-payments list / CSV export / single read — moved verbatim out of invoices.service.ts (SA-065,
// size ratchet). Read-only queries: no writes, no restriction choke-points, no line copiers.
import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { clampLimit } from "../common/pagination";
import { RECEIVED_METHOD_FILTER } from "./payment-predicates";
import { buildPaymentsCsv } from "./payments-csv";
import { tenantCalendarDayEnd, tenantCalendarDayStart } from "./paid-window-bounds";

export interface PaymentListDeps {
  prisma: PrismaService;
  /** The service's tenant-defaults reader (timezone for the paidAt day window). */
  resolveTenantInvoiceDefaults: () => Promise<{ timezone: string | null }>;
}

export interface PaymentListFilters {
  customerId?: string;
  method?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sortBy?: string;
  sortDir?: string;
}

/** Shared `where` + `orderBy` for the list and the CSV export (same filters, same sort whitelist). */
async function buildPaymentListQuery(deps: PaymentListDeps, filters: PaymentListFilters) {
  const { customerId, method, status, dateFrom, dateTo, search, sortBy, sortDir } = filters;

  const where: any = {};
  if (customerId) where.invoice = { customerId };
  if (method) where.method = method;
  if (status) where.status = status;
  if (dateFrom || dateTo) {
    // B89/L-047: paidAt is a REAL instant (not a UTC-midnight calendar
    // stamp), so its day-window bounds are evaluated in the TENANT's own
    // timezone — never the host clock's `setHours`.
    const tenantDefaults = await deps.resolveTenantInvoiceDefaults();
    where.paidAt = {};
    if (dateFrom) where.paidAt.gte = tenantCalendarDayStart(dateFrom, tenantDefaults.timezone);
    if (dateTo) where.paidAt.lte = tenantCalendarDayEnd(dateTo, tenantDefaults.timezone);
  }
  if (search) {
    where.OR = [
      { paymentNumber: { contains: search, mode: "insensitive" } },
      { reference: { contains: search, mode: "insensitive" } },
      { invoice: { customer: { businessName: { contains: search, mode: "insensitive" } } } },
    ];
  }

  // B169: `id` tiebreaker — paidAt/settledAt ties are common (bulk imports,
  // same-day batches), so a single-key orderBy leaves page order unstable.
  const sortDirection = sortDir === "asc" ? "asc" : "desc";
  const validSortFields: Record<string, any> = {
    paidAt: [{ paidAt: sortDirection }, { id: sortDirection }],
    settledAt: [{ settledAt: sortDirection }, { id: sortDirection }],
    amount: [{ amount: sortDirection }, { id: sortDirection }],
    createdAt: [{ createdAt: sortDirection }, { id: sortDirection }],
    paymentNumber: [{ paymentNumber: sortDirection }, { id: sortDirection }],
  };
  // m9: Object.hasOwn (not a bare index) so prototype keys — `constructor`,
  // `__proto__`, `toString`, `valueOf`… — can't resolve to an INHERITED value
  // and reach Prisma as a malformed orderBy (→ 500). Unknown OR inherited
  // falls back to the safe paidAt-desc default.
  const orderBy =
    sortBy && Object.hasOwn(validSortFields, sortBy)
      ? validSortFields[sortBy]
      : [{ paidAt: "desc" }, { id: "desc" }];

  return { where, orderBy };
}

export async function listAllPayments(
  deps: PaymentListDeps,
  query: PaymentListFilters & { page?: number; limit?: number },
) {
  const { page = 1, customerId } = query;
  // Raw query-string limit (no DTO on this route) — clamp so a single request
  // can't force an unbounded scan (security F9-002).
  const limit = clampLimit(query.limit, 25);
  const skip = (page - 1) * limit;

  const { where, orderBy } = await buildPaymentListQuery(deps, query);

  const include = {
    invoice: {
      select: {
        id: true,
        invoiceNumber: true,
        customerId: true,
        customer: { select: { id: true, businessName: true } },
      },
    },
  };

  const [data, total] = await Promise.all([
    deps.prisma.forTenant().invoicePayment.findMany({ where, skip, take: limit, orderBy, include }),
    deps.prisma.forTenant().invoicePayment.count({ where }),
  ]);

  // Summary: total received (PAID only) and advance balance. B421:
  // "received" is cash-only — a CREDIT_NOTE application never counts,
  // regardless of the caller's own `method` filter (if set, it narrows
  // further via AND; it can never widen this back to include CREDIT_NOTE —
  // filtering the LIST to credit-note rows must still show $0 received).
  const { method: whereMethod, ...summaryWhereRest } = where;
  const summaryWhere: any = {
    ...summaryWhereRest,
    status: "PAID",
    AND: [
      { method: RECEIVED_METHOD_FILTER },
      ...(whereMethod != null ? [{ method: whereMethod }] : []),
    ],
  };
  const paidPayments = await deps.prisma.forTenant().invoicePayment.findMany({
    where: summaryWhere,
    select: { amount: true },
  });
  const totalReceived = paidPayments.reduce((s, p) => s + Number(p.amount), 0);

  const advanceWhere: any = customerId ? { customerId } : {};
  const advances = await deps.prisma.forTenant().advancePayment.findMany({
    where: advanceWhere,
    select: { balance: true },
  });
  const advanceBalance = advances.reduce((s, a) => s + Number(a.balance), 0);

  return {
    data,
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    summary: { totalReceived, count: paidPayments.length, advanceBalance },
  };
}

export async function findPaymentById(prisma: PrismaService, paymentId: string) {
  const payment = await prisma.forTenant().invoicePayment.findUnique({
    where: { id: paymentId },
    include: {
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          customerId: true,
          customer: { select: { id: true, businessName: true } },
        },
      },
    },
  });
  if (!payment) throw new NotFoundException("Payment not found");
  return payment;
}

export async function exportPayments(
  deps: PaymentListDeps,
  params: PaymentListFilters,
): Promise<string> {
  const { where, orderBy } = await buildPaymentListQuery(deps, params);

  const rows = await deps.prisma.forTenant().invoicePayment.findMany({
    where,
    orderBy,
    include: {
      invoice: {
        select: {
          invoiceNumber: true,
          customer: { select: { businessName: true } },
        },
      },
    },
  });

  return buildPaymentsCsv(rows);
}
