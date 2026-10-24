/**
 * R4 (SA-770) — a PAST-DUE PARTIAL invoice that still owes is OVERDUE for every reader.
 *
 * Release-4 screen proof: the Overdue KPI tile showed $35.00 ($30 on an OVERDUE invoice + $5 still owed on a
 * past-due PARTIAL one) while the Overdue list showed only the $30 one. The server already agreed with the
 * tile (the sweep never flips PARTIAL to OVERDUE, so "overdue" is DERIVED: open status AND balance due AND
 * past the due day); the web list was sending the strict `status=OVERDUE`. These pins keep the SERVER half of
 * that single rule from drifting:
 *   - the classifier says a PARTIAL owing $5 past its due day is overdue,
 *   - the list's `isOverdue` filter selects PARTIAL and returns that row as overdue with its $5 balance,
 *   - the KPI overdue bucket counts it,
 *   - the list's status set, the KPI's open set and OPEN_INVOICE_STATUSES are the SAME set (a status added to
 *     one reader and not the others fails here).
 * The SQL twin of the same fixture is invoice-balance-sql.parity.db.spec.ts ("partial-past-due").
 *
 * findAll / the KPI only touch `this.prisma` and the tenant-defaults lookup, so both are driven bare, like
 * invoices.service.overdue-balance-sa770.spec.ts.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { InvoiceStatus, UserRole } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { classifyInvoiceBalance } from "./invoice-balance-classify";
import { applyInvoiceStatusFilters } from "./invoice-list-query";
import { computeInvoiceKpiSummary } from "./invoice-kpi-summary";
import { KPI_SUMMARY_EXCLUDED, OPEN_INVOICE_STATUSES } from "./invoice-status-sets";

const TODAY = "2026-09-20";
const CUTOFF = new Date(`${TODAY}T00:00:00.000Z`);

/** INV-0014: PARTIAL, total 35, 30 confirmed paid -> owes 5, due Sep 15 (past due). */
const partialPastDue = () => ({
  id: "inv-0014",
  invoiceNumber: "INV-0014",
  status: "PARTIAL",
  total: 35,
  dueDate: new Date("2026-09-15T00:00:00.000Z"),
  payments: [{ amount: 30, status: "PAID", method: "CASH", createdAt: new Date("2026-09-10") }],
});
/** INV-0016: OVERDUE, total 30, nothing paid -> owes 30. */
const overdueUnpaid = () => ({
  id: "inv-0016",
  invoiceNumber: "INV-0016",
  status: "OVERDUE",
  total: 30,
  dueDate: new Date("2026-09-10T00:00:00.000Z"),
  payments: [],
});

describe("R4 — a past-due PARTIAL invoice that still owes is overdue", () => {
  it("classifier: PARTIAL, owes 5, due day ended -> balance 5 and overdue", () => {
    const inv = partialPastDue();
    expect(classifyInvoiceBalance(inv, CUTOFF)).toEqual({ balanceDue: 5, isOverdue: true });
  });

  it("classifier: a PARTIAL with nothing left is not overdue", () => {
    const inv = { ...partialPastDue(), payments: [{ amount: 35, status: "PAID" }] };
    expect(classifyInvoiceBalance(inv, CUTOFF)).toEqual({ balanceDue: 0, isOverdue: false });
  });

  describe("list (findAll with isOverdue)", () => {
    let prisma: ReturnType<typeof createMockPrisma>;
    let service: InvoicesService;

    beforeEach(() => {
      prisma = createMockPrisma();
      prisma.getTenantId.mockReturnValue("tenant-acme");
      service = Object.create(InvoicesService.prototype) as InvoicesService;
      (service as any).prisma = prisma;
      (service as any).resolveTenantInvoiceDefaults = jest
        .fn()
        .mockResolvedValue({ timezone: "America/Los_Angeles" });
    });

    it("selects PARTIAL (not only the strict OVERDUE status) and returns the row as overdue with its $5", async () => {
      // the SQL predicate (pinned by the parity DB spec) hands back both owing invoices
      prisma.$queryRaw.mockResolvedValue([{ id: "inv-0014" }, { id: "inv-0016" }]);
      prisma.invoice.findMany.mockResolvedValue([partialPastDue(), overdueUnpaid()]);
      prisma.invoice.count.mockResolvedValue(2);

      const res: any = await service.findAll({ isOverdue: true } as any);

      const where = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(where.status.in).toContain("PARTIAL");
      expect(where.id).toEqual({ in: ["inv-0014", "inv-0016"] });
      const byNumber = Object.fromEntries(res.data.map((r: any) => [r.invoiceNumber, r]));
      expect(byNumber["INV-0014"]).toMatchObject({
        status: "PARTIAL",
        balanceDue: 5,
        isOverdue: true,
      });
      expect(byNumber["INV-0016"]).toMatchObject({
        status: "OVERDUE",
        balanceDue: 30,
        isOverdue: true,
      });
      expect(res.meta.total).toBe(2);
    });
  });

  describe("KPI overdue bucket", () => {
    it("counts the PARTIAL's $5 with the $30 OVERDUE one: $35, the same two rows the list returns", async () => {
      const prisma = createMockPrisma();
      prisma.getTenantId.mockReturnValue("tenant-acme");
      prisma.invoice.findMany.mockResolvedValue([partialPastDue(), overdueUnpaid()]);
      prisma.invoicePayment.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([{ avgDays: 0 }]);

      const kpi = await computeInvoiceKpiSummary(
        {
          prisma: prisma as any,
          resolveTenantInvoiceDefaults: async () => ({ timezone: null }),
        },
        TODAY,
        { sub: "op", role: UserRole.OPERATOR } as any,
      );

      expect(kpi.overdue).toBe(35);
      // the KPI reads the whole open set, so PARTIAL is not filtered out before it is classified
      const where = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(where.status.notIn).not.toContain("PARTIAL");
    });
  });

  describe("one status set for 'open / can be overdue'", () => {
    it("the list's isOverdue set, the KPI's open set and OPEN_INVOICE_STATUSES are the same statuses", () => {
      const where: any = {};
      applyInvoiceStatusFilters(where, { isOverdue: true } as any, null);
      const listSet = [...where.status.in].sort();

      const kpiSet = Object.values(InvoiceStatus)
        .filter((s) => !KPI_SUMMARY_EXCLUDED.includes(s))
        .sort();

      expect(listSet).toEqual(kpiSet);
      expect(listSet).toEqual([...OPEN_INVOICE_STATUSES].sort());
      expect(listSet).toContain("PARTIAL");
    });
  });
});
