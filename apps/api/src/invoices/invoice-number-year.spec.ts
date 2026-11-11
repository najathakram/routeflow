import { InvoicesService } from "./invoices.service";

/**
 * W-1188 R22: the year segment of a new invoice number is the tenant's calendar year at mint time, not the server's.
 * `generateInvoiceNumber` needs only the numbering service and the zone read, so the service is built bare.
 */
function build(zoneRow: { timezone: string } | null) {
  const numbering = { reserveNext: jest.fn().mockResolvedValue("INV-X") };
  const prisma = {
    getTenantId: () => "t-1",
    tenantConfig: { findUnique: jest.fn().mockResolvedValue(zoneRow) },
  };
  const service = Object.assign(Object.create(InvoicesService.prototype), { numbering, prisma });
  return {
    service: service as { generateInvoiceNumber(t?: string, tx?: unknown): Promise<string> },
    numbering,
    prisma,
  };
}

describe("invoice number year (W-1188 R22)", () => {
  afterEach(() => jest.useRealTimers());

  it("Dec 31 23:30 in Chicago (2027-01-01T05:30Z) mints INV-2026, not INV-2027", async () => {
    jest.useFakeTimers({ now: new Date("2027-01-01T05:30:00.000Z") });
    const { service, numbering } = build({ timezone: "America/Chicago" });

    await service.generateInvoiceNumber("t-1");

    expect(numbering.reserveNext).toHaveBeenCalledWith(
      "INVOICE",
      expect.objectContaining({ year: 2026 }),
    );
  });

  it("a tenant with no zone reads UTC (guard)", async () => {
    jest.useFakeTimers({ now: new Date("2027-01-01T05:30:00.000Z") });
    const { service, numbering } = build(null);

    await service.generateInvoiceNumber("t-1");

    expect(numbering.reserveNext).toHaveBeenCalledWith(
      "INVOICE",
      expect.objectContaining({ year: 2027 }),
    );
  });

  it("reads the zone ON the caller's transaction when it has one (no second pooled connection)", async () => {
    jest.useFakeTimers({ now: new Date("2027-01-01T05:30:00.000Z") });
    const { service, numbering, prisma } = build(null);
    const tx = {
      tenantConfig: { findUnique: jest.fn().mockResolvedValue({ timezone: "America/Chicago" }) },
    };

    await service.generateInvoiceNumber("t-1", tx);

    expect(tx.tenantConfig.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.tenantConfig.findUnique).not.toHaveBeenCalled();
    expect(numbering.reserveNext).toHaveBeenCalledWith(
      "INVOICE",
      expect.objectContaining({ year: 2026, tx }),
    );
  });
});
