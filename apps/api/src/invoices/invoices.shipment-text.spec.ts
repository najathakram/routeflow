import { InvoicesService } from "./invoices.service";

/**
 * Row 507: `PATCH /invoices/:id/shipment` shares UpdateShipmentDto and the carrier / tracking text guard with
 * the order twin (orders/shipment-text-guard.spec.ts). Only `this.prisma.forTenant().invoice` is touched, so
 * the method runs against a bare stand-in.
 */
describe("InvoicesService.updateInvoiceShipment: carrier / tracking text", () => {
  const findFirst = jest.fn();
  const update = jest.fn();
  const self = { prisma: { forTenant: () => ({ invoice: { findFirst, update } }) } };
  const save = (body: Record<string, unknown>) =>
    InvoicesService.prototype.updateInvoiceShipment.call(self as any, "inv-1", body as any);

  beforeEach(() => {
    jest.resetAllMocks();
    update.mockResolvedValue({ id: "inv-1" });
  });

  it("refuses a formula-led tracking number after the trim (coded 400), nothing written", async () => {
    findFirst.mockResolvedValue({ id: "inv-1", status: "SENT", shippedAt: null });
    await expect(save({ shippingTrackingNumber: "  =cmd" })).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: "TEXT_CELL_FORMULA_LEAD",
        field: "shippingTrackingNumber",
      }),
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a formula-led carrier, naming shippingCarrier", async () => {
    findFirst.mockResolvedValue({ id: "inv-1", status: "SENT", shippedAt: null });
    await expect(save({ shippingCarrier: "@x" })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "TEXT_CELL_FORMULA_LEAD",
        field: "shippingCarrier",
      }),
    });
  });

  it("an echoed stored formula-led value never blocks (change-only)", async () => {
    findFirst.mockResolvedValue({
      id: "inv-1",
      status: "SENT",
      shippedAt: null,
      shippingCarrier: "=Legacy",
      shippingTrackingNumber: "=LEGACY1",
    });
    await save({ shippingCarrier: "=Legacy", shippingTrackingNumber: "=LEGACY1" });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("an ordinary value is trimmed and stored", async () => {
    findFirst.mockResolvedValue({ id: "inv-1", status: "SENT", shippedAt: null });
    await save({ shippingCarrier: " UPS ", shippingTrackingNumber: " 1Z999 " });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shippingCarrier: "UPS", shippingTrackingNumber: "1Z999" }),
      }),
    );
  });
});
