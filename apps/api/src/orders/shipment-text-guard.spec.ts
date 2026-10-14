import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { UpdateShipmentDto } from "./dto/update-shipment.dto";

/**
 * Row 507: the carrier / tracking text of `PATCH /orders/:id/shipment` (and the invoice twin, same DTO) is
 * trimmed, capped and, like every other typed text a spreadsheet export prints, refused when a CHANGED
 * value starts with a formula lead (`safe-text-cell.ts`). An echoed stored value never blocks.
 */
const dto = (plain: Record<string, unknown>) => plainToInstance(UpdateShipmentDto, plain);

describe("UpdateShipmentDto: trim + cap", () => {
  it("trims the carrier and the tracking number", () => {
    const out = dto({ shippingCarrier: "  UPS ", shippingTrackingNumber: "\t1Z999 \n" });
    expect(out.shippingCarrier).toBe("UPS");
    expect(out.shippingTrackingNumber).toBe("1Z999");
  });

  it("whitespace-only becomes an empty string (the clear signal), not a padded value", () => {
    const out = dto({ shippingCarrier: "   ", shippingTrackingNumber: " " });
    expect(out.shippingCarrier).toBe("");
    expect(out.shippingTrackingNumber).toBe("");
  });

  it("an over-long value is refused AFTER the trim (padding cannot push a valid value over)", async () => {
    expect(await validate(dto({ shippingCarrier: "C".repeat(64) }))).toHaveLength(0);
    expect(await validate(dto({ shippingCarrier: `${"C".repeat(64)}   ` }))).toHaveLength(0);
    expect(await validate(dto({ shippingCarrier: "C".repeat(65) }))).not.toHaveLength(0);
    expect(await validate(dto({ shippingTrackingNumber: "9".repeat(128) }))).toHaveLength(0);
    expect(await validate(dto({ shippingTrackingNumber: "9".repeat(129) }))).not.toHaveLength(0);
  });
});

describe("OrdersService.updateShipment: formula-led carrier / tracking text", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  let stored: { shippingCarrier: string | null; shippingTrackingNumber: string | null };
  const save = (body: Record<string, unknown>) =>
    h.service.updateShipment("ord-1", body as any, operatorPayload as any);

  beforeEach(async () => {
    h = await buildOrdersService();
    stored = { shippingCarrier: null, shippingTrackingNumber: null };
    h.prisma.order.findFirst.mockImplementation(() =>
      Promise.resolve({
        id: "ord-1",
        shippedAt: null,
        status: "CONFIRMED",
        fulfillPath: "SHIP",
        customerId: "cust-1",
        orderNumber: "ORD-1",
        ...stored,
      }),
    );
    h.prisma.order.update.mockResolvedValue({ id: "ord-1" });
  });

  it.each(["=HYPERLINK(1)", "+cmd", "-cmd", "@SUM(1)"])(
    "a formula-led tracking number %j is a coded 400 TEXT_CELL_FORMULA_LEAD, nothing written",
    async (tracking) => {
      await expect(save({ shippingTrackingNumber: tracking })).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({
          code: "TEXT_CELL_FORMULA_LEAD",
          field: "shippingTrackingNumber",
        }),
      });
      expect(h.prisma.order.update).not.toHaveBeenCalled();
      expect(h.prisma.invoice.updateMany).not.toHaveBeenCalled();
    },
  );

  it("a formula-led carrier is refused too, naming shippingCarrier", async () => {
    await expect(save({ shippingCarrier: "=1+1" })).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: "TEXT_CELL_FORMULA_LEAD",
        field: "shippingCarrier",
      }),
    });
    expect(h.prisma.order.update).not.toHaveBeenCalled();
  });

  it("the guard sees the TRIMMED value: ' =cmd' must not be stored as '=cmd'", async () => {
    await expect(save({ shippingTrackingNumber: "  =cmd" })).rejects.toMatchObject({
      response: expect.objectContaining({ code: "TEXT_CELL_FORMULA_LEAD" }),
    });
    expect(h.prisma.order.update).not.toHaveBeenCalled();
  });

  it("a numeric-only tracking number (the csv.ts exemption) and an ordinary one are accepted", async () => {
    await save({ shippingTrackingNumber: "-12345678", shippingCarrier: "UPS" });
    await save({ shippingTrackingNumber: "1Z999AA10123456784" });
    expect(h.prisma.order.update).toHaveBeenCalledTimes(2);
  });

  it("an echoed STORED formula-led value never blocks (change-only), so a legacy row can still be edited", async () => {
    stored = { shippingCarrier: "=Legacy", shippingTrackingNumber: "=LEGACY1" };
    await save({ shippingCarrier: "=Legacy", shippingTrackingNumber: "=LEGACY1" });
    expect(h.prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shippingCarrier: "=Legacy",
          shippingTrackingNumber: "=LEGACY1",
        }),
      }),
    );
  });

  it("clearing (empty strings) is always allowed, even over a stored formula-led value", async () => {
    stored = { shippingCarrier: "=Legacy", shippingTrackingNumber: "=LEGACY1" };
    await save({ shippingCarrier: "", shippingTrackingNumber: "" });
    expect(h.prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shippingCarrier: null, shippingTrackingNumber: null }),
      }),
    );
  });
});
