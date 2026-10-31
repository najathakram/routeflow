import { OrdersController } from "../orders/orders.controller";
import { OrderTemplatesController } from "../order-templates/order-templates.controller";

/**
 * SA-1063 MUST 8 — the staff-facing controllers' CUSTOMER routes tell the office after the commit, once, off the
 * request path (`void`), for the surviving order; staff, driver and cron principals never do (MUST 11, R10).
 * The buyer-portal routes are `buyer/buyer.controller.staff-order-email.spec.ts`.
 */
const CUSTOMER = { sub: "u-c", role: "CUSTOMER", tenantId: "t1" } as never;
const OPERATOR = { sub: "u-o", role: "OPERATOR", tenantId: "t1" } as never;
const DRIVER = { sub: "u-d", role: "DRIVER", tenantId: "t1" } as never;

function staffEmailMock() {
  return {
    notifyBuyerOrderPlaced: jest.fn().mockResolvedValue(undefined),
    pendingOrdersOf: jest.fn().mockResolvedValue([]),
    pendingOrdersForUser: jest.fn().mockResolvedValue([]),
    notifyBuyerOrderEdited: jest.fn().mockResolvedValue(undefined),
    notifyBuyerOrderCancelled: jest.fn().mockResolvedValue(undefined),
    orderIsDraft: jest.fn().mockResolvedValue(false),
  };
}

describe("SA-1063 OrdersController CUSTOMER routes", () => {
  const build = () => {
    const orders = {
      create: jest.fn().mockResolvedValue({ id: "ord-1", customerId: "c1", lineItems: [] }),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      changeStatus: jest.fn().mockResolvedValue({ id: "ord-1", lineItems: [] }),
      updateOrderItems: jest.fn().mockResolvedValue({ id: "ord-1", lineItems: [] }),
    };
    const staff = staffEmailMock();
    const controller = new OrdersController(
      orders as never,
      {} as never,
      {} as never,
      {} as never,
      staff as never,
    );
    return { orders, staff, controller };
  };

  it("POST orders/ as CUSTOMER: placed for the created order, not merged", async () => {
    const { staff, controller } = build();
    await controller.create({ items: [] } as never, CUSTOMER);
    expect(staff.notifyBuyerOrderPlaced).toHaveBeenCalledWith("ord-1", {
      merged: false,
      pendingBefore: [],
    });
  });

  it("POST orders/ as CUSTOMER: the sweep's surviving order is the one named, merged true", async () => {
    const { orders, staff, controller } = build();
    orders.mergeAllPendingForCustomer.mockResolvedValue({ id: "ord-older", lineItems: [] });
    await controller.create({ items: [] } as never, CUSTOMER);
    expect(staff.notifyBuyerOrderPlaced).toHaveBeenCalledWith("ord-older", {
      merged: true,
      pendingBefore: [],
    });
  });

  it("R5: the sweep hands back the created order itself (nothing folded, or a replayed key): merged false", async () => {
    const { orders, staff, controller } = build();
    orders.mergeAllPendingForCustomer.mockResolvedValue({ id: "ord-1", lineItems: [] });
    await controller.create({ items: [] } as never, CUSTOMER);
    expect(staff.notifyBuyerOrderPlaced).toHaveBeenCalledWith("ord-1", {
      merged: false,
      pendingBefore: [],
    });
  });

  it("R10: POST orders/ as OPERATOR or DRIVER tells nobody", async () => {
    for (const who of [OPERATOR, DRIVER]) {
      const { staff, controller } = build();
      await controller.create({ items: [] } as never, who);
      expect(staff.notifyBuyerOrderPlaced).not.toHaveBeenCalled();
    }
  });

  it("PATCH orders/:id/items as CUSTOMER: edited; as OPERATOR: nothing", async () => {
    const c = build();
    await c.controller.updateOrderItems("ord-1", { items: [] } as never, CUSTOMER);
    expect(c.staff.notifyBuyerOrderEdited).toHaveBeenCalledWith("ord-1");
    const o = build();
    await o.controller.updateOrderItems("ord-1", { items: [] } as never, OPERATOR);
    expect(o.staff.notifyBuyerOrderEdited).not.toHaveBeenCalled();
  });

  it("PATCH orders/:id/status as CUSTOMER cancelling: draft read BEFORE the cancel, then cancelled", async () => {
    const { orders, staff, controller } = build();
    const order: string[] = [];
    staff.orderIsDraft.mockImplementation(async () => {
      order.push("read");
      return true;
    });
    orders.changeStatus.mockImplementation(async () => {
      order.push("cancel");
      return { id: "ord-1", lineItems: [] };
    });
    await controller.changeStatus("ord-1", { status: "CANCELLED" } as never, CUSTOMER);
    expect(order).toEqual(["read", "cancel"]);
    expect(staff.notifyBuyerOrderCancelled).toHaveBeenCalledWith("ord-1", { wasDraft: true });
  });

  it("PATCH orders/:id/status: a CUSTOMER's other status, or an OPERATOR's cancel, tells nobody", async () => {
    const a = build();
    await a.controller.changeStatus("ord-1", { status: "PENDING" } as never, CUSTOMER);
    expect(a.staff.notifyBuyerOrderCancelled).not.toHaveBeenCalled();
    const b = build();
    await b.controller.changeStatus("ord-1", { status: "CANCELLED" } as never, OPERATOR);
    expect(b.staff.notifyBuyerOrderCancelled).not.toHaveBeenCalled();
  });

  it("a refused cancel is not announced (the service throws before the call)", async () => {
    const { orders, staff, controller } = build();
    orders.changeStatus.mockRejectedValue(new Error("not yours"));
    await expect(
      controller.changeStatus("ord-1", { status: "CANCELLED" } as never, CUSTOMER),
    ).rejects.toThrow("not yours");
    expect(staff.notifyBuyerOrderCancelled).not.toHaveBeenCalled();
  });

  it("the response does not wait for the email", async () => {
    const { staff, controller } = build();
    staff.notifyBuyerOrderPlaced.mockReturnValue(new Promise(() => undefined)); // never settles
    await expect(controller.create({ items: [] } as never, CUSTOMER)).resolves.toBeDefined();
  });
});

describe("SA-1063 OrderTemplatesController generate", () => {
  const build = () => {
    const service = {
      generateOrderForUser: jest.fn().mockResolvedValue({ id: "ord-9", lineItems: [] }),
    };
    const staff = staffEmailMock();
    const controller = new OrderTemplatesController(service as never, staff as never);
    return { staff, controller };
  };

  it("R9: POST order-templates/:id/generate as CUSTOMER -> placed", async () => {
    const { staff, controller } = build();
    await controller.generateOrder("tpl-1", CUSTOMER);
    expect(staff.notifyBuyerOrderPlaced).toHaveBeenCalledWith("ord-9", {
      merged: false,
      pendingBefore: [],
    });
  });

  it("R10: the same route as OPERATOR tells nobody", async () => {
    const { staff, controller } = build();
    await controller.generateOrder("tpl-1", OPERATOR);
    expect(staff.notifyBuyerOrderPlaced).not.toHaveBeenCalled();
  });
});
