import { listInvoices, type InvoiceListDeps } from "./invoice-list";
import { applyInvoiceSearchAndDateFilters } from "./invoice-list-query";
import { OPEN_INVOICE_STATUSES } from "./invoice-status-sets";
import { tenantTodayDay } from "../common/calendar-date";

/**
 * P-30 / SA-1264 PR-1 pins, driven through the real `listInvoices` with a recording fake of the tenant client:
 * F-P1 (Due soon on the TENANT's day), F-P4 (owed reads the confirmed balance, pending beside it), F-P8 (cents), F-P11
 * (Due soon = the Due today chip for a viewer in the tenant's zone).
 */
const NOW_NY_2330_ON_1123 = new Date("2026-11-24T04:30:00.000Z"); // 23:30 on 11-23 in New York

function harness(rows: unknown[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const db = {
    invoice: { findMany, count: jest.fn().mockResolvedValue(rows.length) },
    auditLog: { groupBy: jest.fn().mockResolvedValue([]) },
  };
  const prisma = { forTenant: () => db, getTenantId: () => "t1" };
  const deps = {
    prisma,
    resolveTenantInvoiceDefaults: async () => ({ timezone: "America/New_York" }),
  } as unknown as InvoiceListDeps;
  return { deps, findMany };
}

const payment = (amount: number, status: string) => ({
  id: `p${amount}${status}`,
  amount,
  status,
  method: "CHECK",
  createdAt: new Date("2026-11-01T00:00:00Z"),
});
const invoice = (total: number, payments: unknown[]) => ({
  id: "i1",
  status: "PARTIAL",
  total,
  dueDate: new Date("2026-11-23T00:00:00.000Z"),
  payments,
  customer: { id: "c1", businessName: "Acme Co" },
  order: null,
});

describe("P-30 PR-1 Due soon (dueWithinDays) on the tenant's day", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW_NY_2330_ON_1123);
  });
  afterEach(() => jest.useRealTimers());

  it("F-P1: New York 23:30 on 11-23 (04:30Z on 11-24): dueWithinDays=0 is the window 11-23..11-23", async () => {
    const { deps, findMany } = harness();
    await listInvoices(deps, { dueWithinDays: 0 } as never);
    const where = findMany.mock.calls[0][0].where;
    expect(where.dueDate).toEqual({
      gte: new Date("2026-11-23T00:00:00.000Z"),
      lte: new Date("2026-11-23T23:59:59.999Z"),
    });
    expect(where.status).toEqual({ in: [...OPEN_INVOICE_STATUSES] });
  });

  it("dueWithinDays=7 spans the tenant's today through today + 7, and an explicit status filter stays", async () => {
    const { deps, findMany } = harness();
    await listInvoices(deps, { dueWithinDays: 7, statuses: ["PARTIAL"] } as never);
    const where = findMany.mock.calls[0][0].where;
    expect(where.dueDate).toEqual({
      gte: new Date("2026-11-23T00:00:00.000Z"),
      lte: new Date("2026-11-30T23:59:59.999Z"),
    });
    expect(where.status).toEqual({ in: ["PARTIAL"] });
  });

  it("F-P11: for a viewer in the tenant's zone, Due soon (0) matches the Due today chip (dueFrom = dueTo = today)", async () => {
    const { deps, findMany } = harness();
    await listInvoices(deps, { dueWithinDays: 0 } as never);
    const soon = findMany.mock.calls[0][0].where.dueDate;
    const today = tenantTodayDay("America/New_York", NOW_NY_2330_ON_1123);
    const chip: any = {};
    applyInvoiceSearchAndDateFilters(chip, { dueFrom: today, dueTo: today } as never);
    expect(soon).toEqual(chip.dueDate);
  });
});

describe("P-30 PR-1 the money on a Follow up row", () => {
  it("F-P4: total 100.00, 40.00 confirmed, 60.00 pending: owed 60.00 and pending 60.00", async () => {
    const { deps } = harness([invoice(100, [payment(40, "PAID"), payment(60, "PENDING")])]);
    const { data } = await listInvoices(deps, {} as never);
    expect([(data[0] as any).balanceDue, (data[0] as any).pendingAmount]).toEqual([60, 60]);
  });

  it("F-P8: 100.00 with 33.33 paid shows 66.67 owed and nothing pending", async () => {
    const { deps } = harness([invoice(100, [payment(33.33, "PAID")])]);
    const { data } = await listInvoices(deps, {} as never);
    expect([(data[0] as any).balanceDue, (data[0] as any).pendingAmount]).toEqual([66.67, 0]);
  });
});
