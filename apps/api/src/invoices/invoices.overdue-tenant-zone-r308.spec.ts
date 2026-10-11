/**
 * ACTION-ITEMS row 308 (SA-770 "one predicate"): the staff list row / badge flag and the invoice detail
 * flag judge "overdue" on the INVOICE'S OWN tenant zone, the same cutoff the `isOverdue` list filter and
 * the KPI tiles use. Before, `findAll`'s enrichment and `deriveInvoiceDetailFields` passed the UTC cutoff:
 * an Auckland tenant at 20:00Z on day D filtered "Overdue" and got the invoice due on D (its due day had
 * ended locally) while that very row said isOverdue:false; a west-of-UTC tenant got the reverse for the
 * hours between local evening and 00:00Z.
 *
 * Fixtures: dates are the schema's UTC-midnight "symbolic" calendar stamps.
 *   - Pacific/Auckland is UTC+12 in September (NZST; DST starts 2026-09-27): 20:00Z on Sep 20 is 08:00 on
 *     Sep 21 there, so an invoice due Sep 20 is OVERDUE for the tenant, due-today for a UTC reader.
 *   - America/Chicago is UTC-5 (CDT): 03:00Z on Sep 21 is 22:00 on Sep 20 there, so an invoice due Sep 20
 *     is DUE TODAY for the tenant (grace), overdue for a UTC reader.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { UserRole } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { deriveInvoiceDetailFields } from "./invoice-detail-read";
import { computeInvoiceKpiSummary } from "./invoice-kpi-summary";

const AUCKLAND = "Pacific/Auckland";
const CHICAGO = "America/Chicago";
const AUCKLAND_NOW = new Date("2026-09-20T20:00:00.000Z"); // 08:00 Sep 21 in Auckland
const CHICAGO_NOW = new Date("2026-09-21T03:00:00.000Z"); // 22:00 Sep 20 in Chicago
const DUE_SEP_20 = new Date("2026-09-20T00:00:00.000Z");

const invoice = (over: Record<string, unknown> = {}) => ({
  id: "inv-1",
  invoiceNumber: "INV-0001",
  tenantId: "tenant-acme",
  customerId: "cust-1",
  status: "SENT",
  total: 100,
  dueDate: DUE_SEP_20,
  payments: [],
  items: [],
  ...over,
});

describe("row 308: the staff invoice reads judge overdue in the invoice's tenant zone", () => {
  describe("deriveInvoiceDetailFields (the detail read)", () => {
    it("Auckland, 20:00Z on the due day: overdue for the tenant, not for a zone-less caller", () => {
      expect(deriveInvoiceDetailFields(invoice(), AUCKLAND_NOW, AUCKLAND).isOverdue).toBe(true);
      // no zone given: the documented default is the UTC day (the caller has no tenant)
      expect(deriveInvoiceDetailFields(invoice(), AUCKLAND_NOW).isOverdue).toBe(false);
      expect(deriveInvoiceDetailFields(invoice(), AUCKLAND_NOW, null).isOverdue).toBe(false);
    });

    it("Chicago, 22:00 local on the due day: due today (grace), not overdue; UTC would say overdue", () => {
      expect(deriveInvoiceDetailFields(invoice(), CHICAGO_NOW, CHICAGO).isOverdue).toBe(false);
      expect(deriveInvoiceDetailFields(invoice(), CHICAGO_NOW).isOverdue).toBe(true);
    });

    it("a due-today invoice is never overdue in its own zone, at any hour of the due day", () => {
      const inv = invoice();
      // 00:00:01 and 23:59:59 local on Sep 20 in Auckland
      expect(
        deriveInvoiceDetailFields(inv, new Date("2026-09-19T12:00:01.000Z"), AUCKLAND).isOverdue,
      ).toBe(false);
      expect(
        deriveInvoiceDetailFields(inv, new Date("2026-09-20T11:59:59.000Z"), AUCKLAND).isOverdue,
      ).toBe(false);
      // the next local second
      expect(
        deriveInvoiceDetailFields(inv, new Date("2026-09-20T12:00:00.000Z"), AUCKLAND).isOverdue,
      ).toBe(true);
    });
  });

  describe("service reads (zone resolved ONCE per request, from the tenant's config)", () => {
    let prisma: ReturnType<typeof createMockPrisma>;
    let service: InvoicesService;

    const tenantZone = (timezone: string | null) =>
      prisma.tenantConfig.findUnique.mockResolvedValue({
        invoiceNotes: null,
        invoiceTerms: null,
        timezone,
      });

    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
      });
      prisma = createMockPrisma();
      prisma.getTenantId.mockReturnValue("tenant-acme");
      prisma.auditLog.groupBy.mockResolvedValue([]);
      service = Object.create(InvoicesService.prototype) as InvoicesService;
      Object.assign(service, {
        prisma,
        systemConfig: { get: jest.fn().mockResolvedValue(null) },
      });
    });
    afterEach(() => jest.useRealTimers());

    it("findAll, Auckland: the Overdue filter includes the invoice due on D AND its row says isOverdue", async () => {
      jest.setSystemTime(AUCKLAND_NOW);
      tenantZone(AUCKLAND);
      prisma.$queryRaw.mockResolvedValue([{ id: "inv-1" }]);
      prisma.invoice.findMany.mockResolvedValue([invoice()]);
      prisma.invoice.count.mockResolvedValue(1);

      const res: any = await service.findAll({ isOverdue: true } as any);

      const where = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(DUE_SEP_20 < where.dueDate.lt).toBe(true); // the filter selects it
      expect(res.data[0].isOverdue).toBe(true); // ...and the row agrees (was false: UTC cutoff)
      expect(res.data[0].balanceDue).toBe(100);
    });

    it("findAll without the filter still resolves the zone: Auckland row overdue, Chicago row not", async () => {
      jest.setSystemTime(AUCKLAND_NOW);
      tenantZone(AUCKLAND);
      prisma.invoice.findMany.mockResolvedValue([invoice()]);
      prisma.invoice.count.mockResolvedValue(1);
      const auckland: any = await service.findAll({} as any);
      expect(auckland.data[0].isOverdue).toBe(true);

      jest.setSystemTime(CHICAGO_NOW);
      tenantZone(CHICAGO);
      const chicago: any = await service.findAll({} as any);
      expect(chicago.data[0].isOverdue).toBe(false); // was true: UTC cutoff
    });

    it("findAll, Chicago at 22:00 local on the due day: filter excludes it and the row is not overdue", async () => {
      jest.setSystemTime(CHICAGO_NOW);
      tenantZone(CHICAGO);
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.invoice.findMany.mockResolvedValue([invoice()]);
      prisma.invoice.count.mockResolvedValue(1);

      const res: any = await service.findAll({ isOverdue: true } as any);

      const where = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(DUE_SEP_20 < where.dueDate.lt).toBe(false); // due today: not selected
      expect(res.data[0].isOverdue).toBe(false);
    });

    it("findAll looks the zone up once for a whole page, never per row", async () => {
      jest.setSystemTime(AUCKLAND_NOW);
      tenantZone(AUCKLAND);
      prisma.invoice.findMany.mockResolvedValue(
        [1, 2, 3, 4, 5].map((n) => invoice({ id: `inv-${n}`, invoiceNumber: `INV-${n}` })),
      );
      prisma.invoice.count.mockResolvedValue(5);
      await service.findAll({} as any);
      expect(prisma.tenantConfig.findUnique).toHaveBeenCalledTimes(1);
    });

    it("findAll with no configured zone keeps the UTC day (the filter's own fallback)", async () => {
      jest.setSystemTime(AUCKLAND_NOW);
      tenantZone(null);
      prisma.invoice.findMany.mockResolvedValue([invoice()]);
      prisma.invoice.count.mockResolvedValue(1);
      const res: any = await service.findAll({} as any);
      expect(res.data[0].isOverdue).toBe(false); // due today in UTC
    });

    it("findOne (detail) resolves the tenant's zone once: Auckland overdue, Chicago due-today", async () => {
      prisma.invoice.findUnique.mockResolvedValue(invoice());

      jest.setSystemTime(AUCKLAND_NOW);
      tenantZone(AUCKLAND);
      const a: any = await service.findOne("inv-1", { sub: "op", role: UserRole.OPERATOR } as any);
      expect(a.isOverdue).toBe(true);

      jest.setSystemTime(CHICAGO_NOW);
      tenantZone(CHICAGO);
      prisma.tenantConfig.findUnique.mockClear();
      const c: any = await service.findOne("inv-1", { sub: "op", role: UserRole.OPERATOR } as any);
      expect(c.isOverdue).toBe(false);
      expect(prisma.tenantConfig.findUnique).toHaveBeenCalledTimes(1);
    });

    it("row flag, list filter and KPI tiles agree at the cutoff instant (Auckland and Chicago)", async () => {
      for (const [now, zone] of [
        [AUCKLAND_NOW, AUCKLAND],
        [CHICAGO_NOW, CHICAGO],
      ] as const) {
        jest.setSystemTime(now);
        tenantZone(zone);
        prisma.invoice.findMany.mockReset();
        prisma.invoice.findMany.mockResolvedValue([invoice()]);
        prisma.invoice.count.mockResolvedValue(1);
        prisma.$queryRaw.mockResolvedValue([{ id: "inv-1" }]);

        const res: any = await service.findAll({ isOverdue: true } as any);
        const lt = prisma.invoice.findMany.mock.calls[0][0].where.dueDate.lt as Date;
        const filterSelects = DUE_SEP_20 < lt;

        prisma.invoice.findMany.mockReset();
        prisma.invoice.findMany.mockResolvedValue([invoice()]);
        prisma.invoicePayment.count.mockResolvedValue(0);
        prisma.$queryRaw.mockResolvedValue([{ avgDays: 0 }]);
        const kpi = await computeInvoiceKpiSummary(
          {
            prisma: prisma as any,
            resolveTenantInvoiceDefaults: async () => ({ timezone: zone }),
          },
          "2026-09-20",
          { sub: "op", role: UserRole.OPERATOR } as any,
        );

        expect(res.data[0].isOverdue).toBe(filterSelects);
        expect(kpi.overdue === 100).toBe(filterSelects);
        expect(kpi.dueToday === 100).toBe(!filterSelects);
      }
    });
  });
});
