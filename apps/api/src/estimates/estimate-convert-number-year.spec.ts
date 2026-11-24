import { EstimatesService } from "./estimates.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("../invoices/invoice-restriction-gate", () => ({
  ...jest.requireActual("../invoices/invoice-restriction-gate"),
  tenantId: () => "t-1",
  copy: () => ({}),
}));
jest.mock("../orders/default-sale-fulfilment", () => ({
  defaultSaleFulfilmentKind: jest.fn().mockResolvedValue("DELIVERY"),
}));

/**
 * W-1199 (SA-1261 Y-c): converting an ACCEPTED estimate mints the invoice number in the tenant's year, the same year
 * a direct invoice mint gives (W-1188). At 2026-12-31 23:30 in New York (2027-01-01T04:30Z) both say 2026.
 */
describe("estimate convert: invoice number year (W-1199 Y-c)", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function convertAt(zone: string) {
    jest.useFakeTimers({ now: new Date("2027-01-01T04:30:00.000Z") });
    // The production server runs on UTC; make the host clock say so whatever zone this machine is in.
    jest.spyOn(Date.prototype, "getFullYear").mockImplementation(function (this: Date) {
      return this.getUTCFullYear();
    });
    const numbering = { reserveNext: jest.fn().mockResolvedValue("INV-X") };
    const stop = new Error("stop after the number is reserved");
    // The shared mock gives every model a delegate, so a read convertToInvoice adds later (W-1266: the customer's
    // tier) answers null here instead of throwing on a model this spec never listed.
    const prisma = createMockPrisma();
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: zone });
    prisma.estimate.findUnique.mockResolvedValue({
      id: "e1",
      status: "ACCEPTED",
      customerId: "c1",
      subtotal: 0,
      discount: 0,
      taxAmount: 0,
      total: 0,
      items: [],
    });
    prisma.tenantTransaction.mockRejectedValue(stop);
    const svc = Object.assign(Object.create(EstimatesService.prototype), {
      prisma,
      numbering,
      entitlements: { hasFlag: jest.fn().mockResolvedValue(false) },
      sellingRestrictions: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
    });
    await expect(svc.convertToInvoice("e1")).rejects.toBe(stop);
    return numbering.reserveNext;
  }

  it("a New York tenant: the invoice carries 2026", async () => {
    const reserveNext = await convertAt("America/New_York");
    expect(reserveNext).toHaveBeenCalledWith("INVOICE", expect.objectContaining({ year: 2026 }));
  });

  it("a UTC tenant: the invoice carries 2027", async () => {
    const reserveNext = await convertAt("UTC");
    expect(reserveNext).toHaveBeenCalledWith("INVOICE", expect.objectContaining({ year: 2027 }));
  });
});
