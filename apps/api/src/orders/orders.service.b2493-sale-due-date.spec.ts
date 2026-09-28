import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

/**
 * #2493 item 1 — a van sale's dueDate is checked as a real calendar day BEFORE the order is
 * created. The DTO's `@IsDateString()` passes `2026-02-31`; createSale used to create the order
 * and decrement stock, mark it DELIVERED, and only then 400 at the invoice step, leaving a
 * DELIVERED order with no invoice.
 */
describe("OrdersService.createSale — #2493 dueDate pre-validation", () => {
  const dto = {
    customerId: "cust-1",
    items: [{ productId: "p1", qty: 2, unitPrice: 5 }],
    deliveredNow: true,
  };

  it.each(["2026-02-31", "2026-13-01", "not-a-date"])(
    "refuses dueDate %s before creating the order",
    async (dueDate) => {
      const h = await buildOrdersService();
      const create = jest.spyOn(h.service, "create");
      await expect(
        h.service.createSale({ ...dto, dueDate } as never, operatorPayload as never),
      ).rejects.toThrow("dueDate must be a calendar date (YYYY-MM-DD)");
      expect(create).not.toHaveBeenCalled();
      expect(h.prisma.order.update).not.toHaveBeenCalled();
    },
  );

  it("a real day (or none) passes the pre-check and reaches order creation", async () => {
    for (const dueDate of ["2026-09-25", "2026-09-25T23:30:00-05:00", undefined]) {
      const h = await buildOrdersService();
      const create = jest.spyOn(h.service, "create").mockRejectedValue(new Error("stop-here"));
      await expect(
        h.service.createSale({ ...dto, dueDate } as never, operatorPayload as never),
      ).rejects.toThrow("stop-here");
      expect(create).toHaveBeenCalledTimes(1);
    }
  });
});
