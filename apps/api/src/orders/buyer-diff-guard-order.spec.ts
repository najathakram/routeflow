import { UserRole } from "@prisma/client";
import { OrdersService } from "./orders.service";
import * as unitAware from "./unit-aware-guard";
import * as cancelledLines from "./order-edit-cancelled";
import * as editPayload from "./order-edit-payload";

/**
 * SA-507a (#2272): the ORDER of updateOrderItems' buyer refusals, pinned through the real method.
 * An auto-merge once moved the buyer-diff 400 ahead of the unit guard, so every SA-407 409 shape
 * (unit switch, boxes on a unit line, a new buyer unit line) surfaced as the 400 — green in every
 * mocked spec, red only on real Postgres. Pinned by call order so it can't flip silently again:
 * cancelled lines (SA-422b) → the unit guard (ownership, then the 409s) → the buyer-diff 400.
 */
describe("updateOrderItems — buyer refusal order (SA-507a)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("runs planCancelledLines, then assertOrderEditAllowed, then assertBuyerDiffShape", async () => {
    const order = { id: "ord-1", customerId: "cust-1", status: "PENDING", lineItems: [] };
    const db = {
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      customer: { findFirst: jest.fn().mockResolvedValue({ id: "cust-1" }) },
    };
    const svc: any = Object.assign(Object.create(OrdersService.prototype), {
      prisma: { forTenant: () => db },
    });
    const planned = jest
      .spyOn(cancelledLines, "planCancelledLines")
      .mockResolvedValue({ noop: false } as any);
    const guard = jest.spyOn(unitAware, "assertOrderEditAllowed").mockResolvedValue(undefined);
    const stop = new Error("stop after the shape check");
    const shape = jest.spyOn(editPayload, "assertBuyerDiffShape").mockRejectedValue(stop);

    await expect(
      svc.updateOrderItems(
        "ord-1",
        { replaceAll: false, items: [{ id: "li-1", unitLabel: "Each", qty: 2 }] },
        { role: UserRole.CUSTOMER, sub: "u-1" },
      ),
    ).rejects.toBe(stop);

    expect(planned.mock.invocationCallOrder[0]).toBeLessThan(guard.mock.invocationCallOrder[0]);
    expect(guard.mock.invocationCallOrder[0]).toBeLessThan(shape.mock.invocationCallOrder[0]);
    // The shape check sees the SAME diff classification the cancelled-lines plan did.
    expect(shape.mock.calls[0][3]).toBe(true);
  });
});
