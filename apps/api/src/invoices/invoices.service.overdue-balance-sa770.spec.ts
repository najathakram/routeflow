/**
 * SA-770 (ACTION-ITEMS row 294) — the invoice LIST's `isOverdue` filter keys on BALANCE DUE, not on
 * status + due date alone. Before the fix an OVERPAID invoice (P-3 keeps it out of PAID, so it stays
 * SENT / OVERDUE) and an exactly-paid-but-not-yet-PAID legacy one both listed as overdue.
 *
 * `findAll` only touches `this.prisma` and `resolveTenantInvoiceDefaults`, so the service is built
 * bare (no Nest module) — the whole-service harness lives in invoices.service.spec.ts, which the
 * size ratchet keeps from growing. The SQL itself is pinned by invoice-balance-sql.spec.ts (the bound
 * Sql) and invoice-balance-sql.parity.db.spec.ts (real Postgres: which rows it selects).
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn(),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { InvoicesService } from "./invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";

// Literals on purpose: this spec pins the WIRE (the 10 000 cap, the code string) independently of the
// constants it guards.
const OVERDUE_IDS_CAP = 10_000;
const OPEN = ["SENT", "VIEWED", "PARTIAL", "OVERDUE"];

describe("InvoicesService.findAll — isOverdue means a balance is due (SA-770)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: InvoicesService;
  const rawSql = () => prisma.$queryRaw.mock.calls[0][0] as { sql: string; values: unknown[] };
  const findManyWhere = () => prisma.invoice.findMany.mock.calls[0][0].where;

  beforeEach(() => {
    prisma = createMockPrisma();
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.invoice.count.mockResolvedValue(0);
    service = Object.create(InvoicesService.prototype) as InvoicesService;
    (service as any).prisma = prisma;
    (service as any).resolveTenantInvoiceDefaults = jest
      .fn()
      .mockResolvedValue({ timezone: "America/Los_Angeles" });
  });

  it("lists only the ids whose balance is due: the list's where is `id IN <the helper's ids>`", async () => {
    // partial ($10 due) and unpaid come back; the overpaid and exactly-paid invoices are not in the id set
    prisma.$queryRaw.mockResolvedValue([{ id: "inv-partial" }, { id: "inv-unpaid" }]);
    await service.findAll({ isOverdue: true } as any);
    const where = findManyWhere();
    expect(where.id).toEqual({ in: ["inv-partial", "inv-unpaid"] });
    // the status + due-day clauses stay (belt and braces; same tenant-zone cutoff)
    expect(where.status).toEqual({ in: OPEN });
    expect(where.dueDate.lt).toBeInstanceOf(Date);
  });

  it("nothing owes: the list is empty, not 'every overdue-looking invoice'", async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    const res: any = await service.findAll({ isOverdue: true } as any);
    expect(findManyWhere().id).toEqual({ in: [] });
    expect(res.data).toEqual([]);
  });

  it("the page rows and the total are counted over the SAME where (counts and pagination stay right)", async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.invoice.count.mockResolvedValue(3);
    const res: any = await service.findAll({ isOverdue: true, page: 2, limit: 2 } as any);
    expect(prisma.invoice.count.mock.calls[0][0].where).toBe(findManyWhere());
    expect(findManyWhere().id.in).toHaveLength(3);
    expect(prisma.invoice.findMany.mock.calls[0][0]).toMatchObject({ skip: 2, take: 2 });
    expect(res.meta).toMatchObject({ total: 3, page: 2, limit: 2, totalPages: 2 });
  });

  it("asks the helper for the current tenant's ids with the open statuses and the zone cutoff, bound", async () => {
    prisma.getTenantId.mockReturnValue("tenant-acme");
    prisma.$queryRaw.mockResolvedValue([]);
    await service.findAll({ isOverdue: true } as any);
    const { sql, values } = rawSql();
    expect(values).toEqual(expect.arrayContaining(["tenant-acme", ...OPEN, "PAID"]));
    expect(values).toContain(findManyWhere().dueDate.lt.toISOString());
    expect(sql).not.toContain("tenant-acme");
  });

  it("a buyer's overdue list is narrowed to their own customer inside the id query", async () => {
    prisma.getTenantId.mockReturnValue("tenant-acme");
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-9" });
    prisma.$queryRaw.mockResolvedValue([{ id: "x" }]);
    await service.findAll({ isOverdue: true } as any, { sub: "u1", role: "CUSTOMER" } as any);
    expect(rawSql().values).toContain("cust-9");
    expect(findManyWhere()).toMatchObject({ customerId: "cust-9", id: { in: ["x"] } });
  });

  it("an explicit customerId filter is narrowed inside the id query too", async () => {
    prisma.getTenantId.mockReturnValue("tenant-acme");
    prisma.$queryRaw.mockResolvedValue([]);
    await service.findAll({ isOverdue: true, customerId: "cust-5" } as any);
    expect(rawSql().values).toContain("cust-5");
  });

  it("the date-window chips still intersect with the overdue bound", async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: "a" }]);
    await service.findAll({ isOverdue: true, dueFrom: "2026-08-01" } as any);
    const { dueDate } = findManyWhere();
    expect(dueDate.gte).toEqual(new Date("2026-08-01"));
    expect(dueDate.lt).toBeInstanceOf(Date);
  });

  it("no tenant context: an empty page, no raw query (fail closed, like the KPI summary)", async () => {
    prisma.getTenantId.mockReturnValue(null);
    const res: any = await service.findAll({ isOverdue: true } as any);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(res).toEqual({ data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } });
  });

  it("past the id cap the list answers a coded 422 and reads nothing — it never truncates", async () => {
    prisma.$queryRaw.mockResolvedValue(
      Array.from({ length: OVERDUE_IDS_CAP + 1 }, (_, i) => ({ id: `i${i}` })),
    );
    const err = await service.findAll({ isOverdue: true } as any).catch((e) => e);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse()).toMatchObject({ code: "OVERDUE_FILTER_TOO_BROAD" });
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it("the other filters never touch the raw id query", async () => {
    await service.findAll({} as any);
    await service.findAll({ status: "SENT" } as any);
    await service.findAll({ statuses: ["SENT", "PARTIAL"] } as any);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(
      prisma.invoice.findMany.mock.calls.every((c: any[]) => c[0].where.id === undefined),
    ).toBe(true);
  });
});
