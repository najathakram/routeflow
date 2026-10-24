import { OrderStatus } from "@prisma/client";
// the harness first: it loads OrdersService through the module graph the Nest injector expects
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { fulfillPathLocked } from "./fulfil-path-lock";
import { OrdersService } from "./orders.service";

/**
 * Row 673 (SA-831b M6): mobile POS offered "Switch to delivery" on a "Ready for pickup" order and the server always
 * refused it. The client guessed the rule from the status. Now there is ONE predicate (`fulfillPathLocked`): the
 * `PATCH /orders/:id/fulfill-path` refusal reads it, and the order read carries it (`fulfillPathLocked`) so a client
 * never re-derives it. This spec pins that the read and the write can never disagree, for every status.
 */
const ALL = Object.values(OrderStatus);
const LOCKED: OrderStatus[] = [
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
];

describe("row 673: fulfillPathLocked, the one fulfil-path predicate", () => {
  it.each(ALL)("%s", (status) => {
    expect(fulfillPathLocked({ status })).toBe(LOCKED.includes(status));
  });

  describe("PATCH /orders/:id/fulfill-path refuses exactly when the predicate locks", () => {
    let h: Awaited<ReturnType<typeof buildOrdersService>>;
    beforeEach(async () => {
      h = await buildOrdersService();
      (h.service as any).featureConfig = { getEffectiveMode: jest.fn(async () => "both") };
      h.prisma.order.update.mockImplementation((a: any) =>
        Promise.resolve({ id: "ord-1", ...a.data }),
      );
    });

    it.each(ALL)("%s", async (status) => {
      h.prisma.order.findFirst.mockResolvedValue({
        id: "ord-1",
        status,
        fulfillPath: "PICKUP",
        routeRunId: null,
        routeRunStopId: null,
        routeRunStop: null,
        routeRun: null,
      });
      const run = h.service.updateFulfillPath(
        "ord-1",
        { fulfillPath: "ROUTE" } as any,
        operatorPayload as any,
      );
      if (fulfillPathLocked({ status })) {
        await expect(run).rejects.toMatchObject({ status: 400 });
        expect(h.prisma.order.update).not.toHaveBeenCalled();
      } else {
        await expect(run).resolves.toMatchObject({ fulfillPath: "ROUTE" });
      }
    });
  });

  it("GET /orders/:id carries fulfillPathLocked from the same predicate", async () => {
    const read = async (status: OrderStatus) => {
      const db = {
        order: {
          findUnique: jest.fn().mockResolvedValue({
            id: "o1",
            tenantId: "t1",
            status,
            fulfillPath: "PICKUP",
            lineItems: [],
            invoices: [],
          }),
        },
        return: { count: jest.fn().mockResolvedValue(0) },
        orderRevision: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const self: any = {
        prisma: { forTenant: () => db, getTenantId: () => "t1" },
        featureConfig: { getEffectiveMode: jest.fn().mockResolvedValue("unset") },
      };
      return (OrdersService.prototype as any).findOne.call(self, "o1", {
        sub: "u1",
        role: "OPERATOR",
        tenantId: "t1",
      });
    };
    expect((await read(OrderStatus.CONFIRMED)).fulfillPathLocked).toBe(false);
    expect((await read(OrderStatus.OUT_FOR_DELIVERY)).fulfillPathLocked).toBe(true);
  });
});
