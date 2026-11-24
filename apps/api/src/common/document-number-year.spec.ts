import { CommissionStatementsService } from "../sales-agents/commission-statements.service";
import { EstimatesService } from "../estimates/estimates.service";
import { InlineReturnsService } from "../returns/inline-returns.service";
import { InventoryService } from "../inventory/inventory.service";
import { NumberingService } from "../import/numbering.service";
import { ReturnsService } from "../returns/returns.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";

/**
 * W-1199 (SA-1261 Y-a..Y-d): the year segment of EVERY document number is the tenant's calendar year, not the
 * server clock's. The instant below is 2026-12-31 23:30 in New York and 2027-01-01 00:00 in UTC+5 and later, so a
 * server running on UTC says 2027 while the New York business is still living in 2026.
 */
const NEW_YEAR_UTC = new Date("2027-01-01T04:30:00.000Z");
const NY = { timezone: "America/New_York" };
const UTC_TENANT = { timezone: "UTC" };

/** A tx / pool whose zone read returns `row`; `getTenantId` only exists on the pooled service. */
function zoneDb(row: { timezone: string } | null, extra: Record<string, unknown> = {}) {
  return { tenantConfig: { findUnique: jest.fn().mockResolvedValue(row) }, ...extra };
}
function pool(row: { timezone: string } | null) {
  return { ...zoneDb(row), getTenantId: () => "t-1" };
}
/** A pool whose zone read must NEVER be used: the site has its own tx, so a second connection would be a bug. */
function poolNeverRead() {
  return {
    getTenantId: () => "t-1",
    tenantConfig: {
      findUnique: jest.fn().mockImplementation(() => {
        throw new Error("zone read on the pool while a tx is held");
      }),
    },
  };
}
/** The production server runs on UTC; make the host clock say so whatever zone this machine is in. */
function runServerOnUtc() {
  jest.spyOn(Date.prototype, "getFullYear").mockImplementation(function (this: Date) {
    return this.getUTCFullYear();
  });
}
function make<T>(cls: { prototype: T }, deps: Record<string, unknown>) {
  return Object.assign(Object.create(cls.prototype as object), deps) as any;
}

describe("document number year (W-1199)", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NEW_YEAR_UTC });
    runServerOnUtc();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe.each([
    ["Y-a New York", NY, 2026],
    ["Y-b UTC", UTC_TENANT, 2027],
  ])("%s tenant at the New Year instant", (_label, zone, year) => {
    it(`estimate number carries ${year}`, async () => {
      const numbering = { reserveNext: jest.fn().mockResolvedValue("EST-X") };
      const svc = make(EstimatesService, { numbering, prisma: pool(zone) });
      await svc.nextEstNumber();
      expect(numbering.reserveNext).toHaveBeenCalledWith(
        "ESTIMATE",
        expect.objectContaining({ year }),
      );
    });

    it(`credit-note number (order-create reservation) carries ${year}`, async () => {
      const numbering = { reserveNext: jest.fn().mockResolvedValue("CN-X") };
      const svc = make(InlineReturnsService, { numbering, prisma: pool(zone) });
      await svc.reserveCreditNoteNumber();
      expect(numbering.reserveNext).toHaveBeenCalledWith(
        "CREDIT_NOTE",
        expect.objectContaining({ year }),
      );
    });

    it(`return number carries ${year}, read on the caller's tx`, async () => {
      const numbering = { reserveNext: jest.fn().mockResolvedValue("RET-X") };
      const svc = make(ReturnsService, { numbering, prisma: poolNeverRead() });
      const tx = zoneDb(zone);
      await svc.generateReturnNumber(tx);
      expect(numbering.reserveNext).toHaveBeenCalledWith(
        "RETURN",
        expect.objectContaining({ year, tx }),
      );
      expect(tx.tenantConfig.findUnique).toHaveBeenCalledTimes(1);
    });

    it(`PO number carries ${year}`, async () => {
      const svc = make(InventoryService, { prisma: poolNeverRead() });
      const tx = zoneDb(zone, { purchaseOrder: { findFirst: jest.fn().mockResolvedValue(null) } });
      expect(await svc.nextPoNumber(tx)).toBe(`PO-${year}-0001`);
    });

    it(`vendor bill number carries ${year}`, async () => {
      const svc = make(VendorBillsService, { prisma: poolNeverRead() });
      const tx = zoneDb(zone, {
        $executeRaw: jest.fn().mockResolvedValue(0),
        vendorBill: { findFirst: jest.fn().mockResolvedValue(null) },
      });
      expect(await svc.nextBillNumber(tx)).toBe(`BILL-${year}-0001`);
    });

    it(`commission statement number carries ${year}`, async () => {
      const svc = make(CommissionStatementsService, { prisma: poolNeverRead() });
      const tx = zoneDb(zone, {
        commissionStatement: { findFirst: jest.fn().mockResolvedValue(null) },
      });
      expect(await svc.nextStatementNumber(tx)).toBe(`CST-${year}-0001`);
    });
  });

  it("Y-d: the settings preview shows the tenant's year (2026), the number the mint will give", async () => {
    const prisma = {
      ...pool(NY),
      forTenant: () => ({ numberingSequence: { findMany: jest.fn().mockResolvedValue([]) } }),
      tenantTransaction: (fn: (tx: unknown) => unknown) => fn({}),
    };
    const svc = make(NumberingService, { prisma });
    const preview = jest.spyOn(svc, "previewUnconfigured").mockResolvedValue("P-X");
    await svc.getSettings();
    expect(preview).toHaveBeenCalled();
    for (const call of preview.mock.calls) expect(call[5]).toBe(2026);
  });

  it("no tenant id and a bare tx: UTC, never a throw", async () => {
    const svc = make(CommissionStatementsService, {
      prisma: { getTenantId: () => null },
    });
    const tx = { commissionStatement: { findFirst: jest.fn().mockResolvedValue(null) } };
    expect(await svc.nextStatementNumber(tx)).toBe("CST-2027-0001");
  });
});
