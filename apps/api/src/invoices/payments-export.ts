/**
 * Payments CSV export — moved verbatim out of invoices.service.ts (size ratchet, SA-065). Read-only:
 * one invoicePayment.findMany, then CSV formatting. The service keeps `exportPayments` as a
 * delegator and passes its own tenant-scoped client and calendar-day helpers.
 */
export type PaymentsExportParams = {
  customerId?: string;
  method?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sortBy?: string;
  sortDir?: string;
};

export interface PaymentsExportDeps {
  /** Tenant-scoped client, read at the same point the service used to call forTenant(). */
  db: () => any;
  resolveTenantInvoiceDefaults: () => Promise<{ timezone: string | null }>;
  tenantCalendarDayStart: (dateStr: string, timeZone: string | null) => Date;
  tenantCalendarDayEnd: (dateStr: string, timeZone: string | null) => Date;
}

export async function exportPaymentsCsv(
  deps: PaymentsExportDeps,
  params: PaymentsExportParams,
): Promise<string> {
  const { customerId, method, status, dateFrom, dateTo, search, sortBy, sortDir } = params;

  const where: any = {};
  if (customerId) where.invoice = { customerId };
  if (method) where.method = method;
  if (status) where.status = status;
  if (dateFrom || dateTo) {
    // B89/L-047: paidAt is a REAL instant, so its day-window bounds are
    // evaluated in the TENANT's own timezone — same convention as
    // listAllPayments above.
    const tenantDefaults = await deps.resolveTenantInvoiceDefaults();
    where.paidAt = {};
    if (dateFrom) where.paidAt.gte = deps.tenantCalendarDayStart(dateFrom, tenantDefaults.timezone);
    if (dateTo) where.paidAt.lte = deps.tenantCalendarDayEnd(dateTo, tenantDefaults.timezone);
  }
  if (search) {
    where.OR = [
      { paymentNumber: { contains: search, mode: "insensitive" } },
      { reference: { contains: search, mode: "insensitive" } },
      { invoice: { customer: { businessName: { contains: search, mode: "insensitive" } } } },
    ];
  }

  // B169: `id` tiebreaker — same convention as listAllPayments above.
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

  const rows = await deps.db().invoicePayment.findMany({
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

  const escape = (v: any) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const header =
    "Payment#,Date,Bank Date,Customer,Invoice#,Method,Reference,Bank Charges,Amount,Status";
  const lines = rows.map((r: any) =>
    [
      escape(r.paymentNumber ?? ""),
      escape(r.paidAt ? new Date(r.paidAt).toISOString().split("T")[0] : ""),
      escape(r.settledAt ? new Date(r.settledAt).toISOString().split("T")[0] : ""),
      escape(r.invoice?.customer?.businessName ?? ""),
      escape(r.invoice?.invoiceNumber ?? ""),
      escape(r.method ?? ""),
      escape(r.reference ?? ""),
      escape(r.bankCharges != null ? Number(r.bankCharges).toFixed(2) : ""),
      escape(Number(r.amount).toFixed(2)),
      escape(r.status ?? ""),
    ].join(","),
  );

  return [header, ...lines].join("\n");
}
