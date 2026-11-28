/**
 * B1343 (SA-1330 Amendment 1): a force consolidate names each order it kept out, as a `keptSeparate` ride-along on the
 * result, the same shape as F-05's `bannedLines` (SA-255). A null result stays null; an empty list adds no key. The
 * real-Postgres side (which orders are kept out, and why) lives in merge-money-hold-b1343.db.spec.ts.
 */
import { OrdersController } from "./orders.controller";

type Kept = { orderId: string; orderNumber: string | null; reason: string };

function controllerWith(result: unknown, kept?: Kept[], banned?: unknown[]) {
  const ordersService = {
    forceConsolidateCustomer: jest.fn(async (_customerId: string, opts: any) => {
      if (kept) opts.onKeptSeparate?.(kept);
      if (banned) opts.onBannedLines?.(banned);
      return result;
    }),
  };
  const controller = new OrdersController(
    ordersService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { controller, ordersService };
}

const user = { sub: "u1", role: "OPERATOR", tenantId: "t1" } as any;
const winner = { id: "w1", orderNumber: "ORD-0001", lineItems: [] };

describe("POST orders/force-consolidate/:customerId — keptSeparate (B1343, SA-1330 A1)", () => {
  it("8/9: an order kept out for money rides along with its id, number and MONEY_ON_ORDER", async () => {
    const kept = [{ orderId: "o2", orderNumber: "ORD-0002", reason: "MONEY_ON_ORDER" }];
    const { controller } = controllerWith(winner, kept);
    expect(await controller.forceConsolidate("c1", user)).toEqual({
      ...winner,
      keptSeparate: kept,
    });
  });

  it("10: a multi-draft skip rides along as MULTI_DRAFT", async () => {
    const kept = [{ orderId: "o3", orderNumber: null, reason: "MULTI_DRAFT" }];
    const { controller } = controllerWith(winner, kept);
    expect(await controller.forceConsolidate("c1", user)).toEqual({
      ...winner,
      keptSeparate: kept,
    });
  });

  it("11: nothing kept out adds no keptSeparate key (never an empty array)", async () => {
    const { controller } = controllerWith(winner, []);
    const out = await controller.forceConsolidate("c1", user);
    expect(out).toEqual(winner);
    expect(out).not.toHaveProperty("keptSeparate");
  });

  it("a null result stays null, even with orders kept out", async () => {
    const kept = [{ orderId: "o2", orderNumber: "ORD-0002", reason: "MONEY_ON_ORDER" }];
    const { controller } = controllerWith(null, kept);
    expect(await controller.forceConsolidate("c1", user)).toBeNull();
  });

  it("bannedLines rides along as before, beside keptSeparate", async () => {
    const kept = [{ orderId: "o2", orderNumber: "ORD-0002", reason: "MONEY_ON_ORDER" }];
    const banned = [{ productId: "p1" }];
    const { controller } = controllerWith(winner, kept, banned);
    expect(await controller.forceConsolidate("c1", user)).toEqual({
      ...winner,
      bannedLines: banned,
      keptSeparate: kept,
    });
    const onlyBanned = controllerWith(winner, [], banned).controller;
    expect(await onlyBanned.forceConsolidate("c1", user)).toEqual({
      ...winner,
      bannedLines: banned,
    });
  });

  it("passes the actor and both callbacks to the service", async () => {
    const { controller, ordersService } = controllerWith(winner);
    await controller.forceConsolidate("c1", user);
    const opts = ordersService.forceConsolidateCustomer.mock.calls[0][1];
    expect(opts.actor).toBe(user);
    expect(typeof opts.onBannedLines).toBe("function");
    expect(typeof opts.onKeptSeparate).toBe("function");
  });
});
