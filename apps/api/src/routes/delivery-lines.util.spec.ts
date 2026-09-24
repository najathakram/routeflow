import { BadRequestException, NotFoundException } from "@nestjs/common";
import { assertDeliveriesFitStop } from "./delivery-lines.util";

function mockTx(item: { id: string; orderId: string; qty: number }, priorEvidence: any[]) {
  return {
    orderItem: { findMany: jest.fn().mockResolvedValue([item]) },
    deliveryMutation: { findMany: jest.fn().mockResolvedValue(priorEvidence) },
  };
}

describe("assertDeliveriesFitStop (B785/SA-116/SA-133: bounds against REMAINING, not full ordered qty)", () => {
  const item = { id: "oi1", orderId: "o1", qty: 10 };

  it("refuses a second visit that would exceed what's actually remaining, even though it's under the full ordered qty", async () => {
    // 7 of 10 already delivered at a DIFFERENT prior stop.
    const tx = mockTx(item, [
      {
        orderId: "o1",
        orderItemId: "oi1",
        routeRunStopId: "stop-prior",
        type: "DELIVERED",
        quantityDelivered: 7,
      },
    ]);

    await expect(
      assertDeliveriesFitStop(
        tx,
        "stop-now",
        [{ id: "o1" }],
        [{ orderItemId: "oi1", quantityDelivered: 5 }],
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("accepts a second visit that fits within what's remaining", async () => {
    const tx = mockTx(item, [
      {
        orderId: "o1",
        orderItemId: "oi1",
        routeRunStopId: "stop-prior",
        type: "DELIVERED",
        quantityDelivered: 7,
      },
    ]);

    await expect(
      assertDeliveriesFitStop(
        tx,
        "stop-now",
        [{ id: "o1" }],
        [{ orderItemId: "oi1", quantityDelivered: 3 }],
      ),
    ).resolves.toBeUndefined();
  });

  it("a prior REFUSED visit leaves the full ordered qty available to a later re-delivery", async () => {
    const tx = mockTx(item, [
      {
        orderId: "o1",
        orderItemId: "oi1",
        routeRunStopId: "stop-prior",
        type: "REFUSED",
        quantityDelivered: 0,
      },
    ]);

    await expect(
      assertDeliveriesFitStop(
        tx,
        "stop-now",
        [{ id: "o1" }],
        [{ orderItemId: "oi1", quantityDelivered: 10 }],
      ),
    ).resolves.toBeUndefined();
  });

  it("a first-ever visit (no prior evidence) is still bounded by the full ordered qty", async () => {
    const tx = mockTx(item, []);

    await expect(
      assertDeliveriesFitStop(
        tx,
        "stop-now",
        [{ id: "o1" }],
        [{ orderItemId: "oi1", quantityDelivered: 11 }],
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("SA-133: excludes THIS stop's own rows from the sum, so an idempotency replay never double-counts its own prior attempt", async () => {
    // A row already exists at THIS SAME stop (e.g. a defensive re-check mid-replay) —
    // it must not count against the very delivery it belongs to.
    const tx = mockTx(item, [
      {
        orderId: "o1",
        orderItemId: "oi1",
        routeRunStopId: "stop-now",
        type: "DELIVERED",
        quantityDelivered: 7,
      },
    ]);

    await expect(
      assertDeliveriesFitStop(
        tx,
        "stop-now",
        [{ id: "o1" }],
        [{ orderItemId: "oi1", quantityDelivered: 10 }],
      ),
    ).resolves.toBeUndefined();
  });

  it("still 404s an order item the tenant-scoped read can't find", async () => {
    const tx = {
      orderItem: { findMany: jest.fn().mockResolvedValue([]) },
      deliveryMutation: { findMany: jest.fn().mockResolvedValue([]) },
    };

    await expect(
      assertDeliveriesFitStop(
        tx,
        "stop-now",
        [{ id: "o1" }],
        [{ orderItemId: "oi1", quantityDelivered: 1 }],
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
