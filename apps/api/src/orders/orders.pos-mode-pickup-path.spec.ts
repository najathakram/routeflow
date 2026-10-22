// order create runs the merge/stock paths under advisory locks: not under test here.
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { FulfillPath, UserRole } from "@prisma/client";
import { activeFulfilPath, fulfilCaller, resolveFulfilPath } from "./fulfil-path-resolver";
import {
  buildOrdersService,
  customerPayload,
  operatorPayload,
} from "./testing/orders-service-harness";

/**
 * SA-763r P-1a red row (1): a staff member who may use POS mode (OPERATOR, TENANT_ADMIN) who asks for
 * PICKUP explicitly gets PICKUP whatever the tenant offers its customers, through EVERY path that
 * resolves the order's fulfil path: order create, the merge-candidate search and the controller
 * pre-resolve (the controller's wiring is pinned in orders.controller.merge-choice.spec.ts). Guards: a
 * buyer keeps the 400, a DRIVER is refused, a system caller (a standing-order template) never gets it.
 */
const P = FulfillPath.PICKUP;
const deps = (mode: string | Error) => ({
  featureConfig: {
    getEffectiveMode: jest.fn(async () => {
      if (mode instanceof Error) throw mode;
      return mode;
    }),
  },
  tenantId: "t1",
  logger: { warn: jest.fn() },
});
const notOffered = {
  status: 400,
  response: expect.objectContaining({ code: "FULFIL_METHOD_NOT_OFFERED" }),
};
// Every capability that does NOT offer pickup: the delivery-only tenants the row is about.
const DELIVERY_ONLY = ["unset", "delivery", "both", "ship"] as const;
// Where the portal offers a choice a buyer's PICKUP is a coded 400; "unset" offers none, so a buyer's request
// is ignored there (today's rule) and the buyer gets the customer's own path: never PICKUP either way.
const BUYER_REFUSED = ["delivery", "both", "ship"] as const;

describe("resolveFulfilPath: staff POS mode", () => {
  it.each(DELIVERY_ONLY)("%s tenant: an OPERATOR's explicit PICKUP is PICKUP", async (mode) => {
    for (const role of [UserRole.OPERATOR, UserRole.TENANT_ADMIN]) {
      const input = { explicit: P, stored: FulfillPath.ROUTE, audience: "staff", role } as const;
      expect(await resolveFulfilPath(deps(mode), input)).toBe(P);
      expect(await activeFulfilPath(deps(mode), input)).toBe(P);
    }
  });

  it("a capability read blip or no feature-config service does not block a POS-mode PICKUP", async () => {
    const input = {
      explicit: P,
      stored: null,
      audience: "staff",
      role: UserRole.OPERATOR,
    } as const;
    expect(await resolveFulfilPath(deps(new Error("db down")), input)).toBe(P);
    expect(await resolveFulfilPath({ tenantId: "t1" }, input)).toBe(P);
  });

  it("unset tenant guard: a buyer's PICKUP is ignored (the customer's own path), never PICKUP", async () => {
    const input = {
      explicit: P,
      stored: FulfillPath.ROUTE,
      audience: "buyer",
      role: UserRole.CUSTOMER,
    } as const;
    expect(await resolveFulfilPath(deps("unset"), input)).toBe(FulfillPath.ROUTE);
  });

  it.each(BUYER_REFUSED)(
    "%s tenant guard: a buyer asking for PICKUP is still refused",
    async (mode) => {
      await expect(
        resolveFulfilPath(deps(mode), {
          explicit: P,
          stored: FulfillPath.ROUTE,
          audience: "buyer",
          role: UserRole.CUSTOMER,
        }),
      ).rejects.toMatchObject(notOffered);
      // a buyer with an operator-looking role is still the buyer audience: no POS mode
      await expect(
        resolveFulfilPath(deps(mode), {
          explicit: P,
          stored: FulfillPath.ROUTE,
          audience: "buyer",
          role: UserRole.OPERATOR,
        }),
      ).rejects.toMatchObject(notOffered);
    },
  );

  it.each(DELIVERY_ONLY)(
    "%s tenant guard: a DRIVER, a SUPER_ADMIN or a system caller (null) is refused",
    async (mode) => {
      for (const role of [UserRole.DRIVER, UserRole.SUPER_ADMIN, null]) {
        await expect(
          resolveFulfilPath(deps(mode), {
            explicit: P,
            stored: FulfillPath.ROUTE,
            audience: "staff",
            role,
          }),
        ).rejects.toMatchObject(notOffered);
      }
    },
  );

  it("POS mode only opens an EXPLICIT PICKUP: omitted keeps today's rule, SHIP and ROUTE are untouched", async () => {
    const operator = { audience: "staff", role: UserRole.OPERATOR } as const;
    expect(
      await resolveFulfilPath(deps("delivery"), { stored: FulfillPath.ROUTE, ...operator }),
    ).toBe(FulfillPath.ROUTE);
    expect(await resolveFulfilPath(deps("ship"), { stored: FulfillPath.ROUTE, ...operator })).toBe(
      FulfillPath.SHIP,
    );
    expect(
      await resolveFulfilPath(deps("both"), {
        explicit: FulfillPath.SHIP,
        stored: null,
        ...operator,
      }),
    ).toBe(FulfillPath.SHIP);
  });

  it("fulfilCaller: a CUSTOMER is the buyer audience, every other role is staff, the role rides along", () => {
    expect(fulfilCaller({ role: UserRole.CUSTOMER })).toEqual({
      audience: "buyer",
      role: "CUSTOMER",
    });
    expect(fulfilCaller({ role: UserRole.OPERATOR })).toEqual({
      audience: "staff",
      role: "OPERATOR",
    });
    expect(fulfilCaller({ role: UserRole.DRIVER })).toEqual({ audience: "staff", role: "DRIVER" });
  });
});

describe("OrdersService: POS-mode PICKUP through create and the merge-candidate search", () => {
  const PRODUCT = { id: "prod-1", name: "Tomatoes", pricePerUnit: 4.99, unit: "punnet" };
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const mode = (m: string) => {
    (h.service as any).featureConfig = { getEffectiveMode: jest.fn(async () => m) };
  };
  const created = () => h.prisma.order.create.mock.calls.at(-1)?.[0]?.data?.fulfillPath;
  const create = (dto: Record<string, unknown>, user: unknown = operatorPayload) =>
    h.service.create(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }], ...dto } as any,
      user as any,
    );

  beforeEach(async () => {
    h = await buildOrdersService();
    const customer = () =>
      Promise.resolve({
        id: "cust-1",
        businessName: "Acme Foods",
        pricingTier: 1,
        fulfillPath: "ROUTE",
        deletedAt: null,
        user: { status: "ACTIVE" },
      });
    h.prisma.customer.findFirst.mockImplementation(customer);
    h.prisma.customer.findUnique.mockImplementation(customer);
    // SA-822 MUST 1: an explicit staff PICKUP asks the till; the operator here is denied no group.
    h.prisma.user.findFirst.mockResolvedValue({
      deniedPermissionGroups: [],
      permissionsVersion: 1,
    });
    h.prisma.product.findMany.mockResolvedValue([PRODUCT]);
    h.prisma.order.create.mockResolvedValue({
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-1",
      status: "PENDING",
      total: 4.99,
      urgent: false,
      createdAt: new Date(),
      customer: { id: "cust-1", businessName: "Acme Foods" },
      lineItems: [],
    });
    (h.service as any).systemConfig.get.mockResolvedValue("0");
  });

  it.each(DELIVERY_ONLY)(
    "create, %s tenant: an OPERATOR's explicit PICKUP is the stored path",
    async (m) => {
      mode(m);
      await create({ fulfillPath: "PICKUP" });
      expect(created()).toBe("PICKUP");
      await create({ fulfillPath: "PICKUP" }, { ...operatorPayload, role: "TENANT_ADMIN" });
      expect(created()).toBe("PICKUP");
    },
  );

  it.each(DELIVERY_ONLY)(
    "create, %s tenant guard: a buyer is a coded 400, a DRIVER is refused, nothing written",
    async (m) => {
      mode(m);
      const driver = { ...operatorPayload, sub: "user-drv", role: "DRIVER" as const };
      // "unset" offers buyers no choice: their PICKUP is ignored there (below), so only the driver is refused.
      for (const user of m === "unset" ? [driver] : [customerPayload, driver]) {
        await expect(create({ fulfillPath: "PICKUP" }, user)).rejects.toMatchObject(notOffered);
      }
      expect(h.prisma.order.create).not.toHaveBeenCalled();
    },
  );

  it("create, unset tenant guard: a buyer's PICKUP is ignored, the order is never PICKUP", async () => {
    mode("unset");
    await create({ fulfillPath: "PICKUP" }, customerPayload);
    expect(created()).toBe("ROUTE");
  });

  it("the merge-candidate search resolves an OPERATOR's PICKUP on a ship-only tenant: PICKUP orders only", async () => {
    mode("ship");
    h.prisma.order.findFirst.mockResolvedValue(null);
    await h.service.findActiveOrder("cust-1", {
      forMerge: true,
      mergeAs: { explicit: "PICKUP", audience: "staff", role: "OPERATOR" },
    });
    expect(h.prisma.order.findFirst.mock.calls[0][0].where).toMatchObject({
      fulfillPath: "PICKUP",
    });
  });

  it("the merge-candidate search guards: a buyer or a DRIVER asking for PICKUP is refused like create", async () => {
    mode("ship");
    h.prisma.order.findFirst.mockResolvedValue(null);
    for (const mergeAs of [
      { explicit: "PICKUP", audience: "buyer", role: "CUSTOMER" },
      { explicit: "PICKUP", audience: "staff", role: "DRIVER" },
      { explicit: "PICKUP", audience: "staff", role: null },
    ] as const) {
      await expect(
        h.service.findActiveOrder("cust-1", { forMerge: true, mergeAs }),
      ).rejects.toMatchObject(notOffered);
    }
    expect(h.prisma.order.findFirst).not.toHaveBeenCalled();
  });
});
