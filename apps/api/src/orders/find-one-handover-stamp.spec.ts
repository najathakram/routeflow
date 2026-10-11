jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import type { InvoicesService } from "../invoices/invoices.service";
import { OrdersService } from "./orders.service";
import { pickCustomerInvoiceFields, toCustomerOrder } from "../common/staff-only-fields";
import { seesHandOverStamp } from "./handover-stamp";

/**
 * Row 342: the staff order / invoice detail carries the register and the cashier ("Handed over at register main
 * by Pat"). The select, not a mapper, decides what a read returns, so the select is pinned per caller: staff get
 * the cashier's username only (never an email or other user column); a buyer, a driver and an unauthenticated
 * internal read get no cashier relation at all; and the buyer projections (allowlists) name neither field.
 * Placeholders only (acme).
 */
const caller = (role: string) =>
  ({
    sub: "u-1",
    username: "x",
    role,
    status: "ACTIVE",
    forcePasswordChange: false,
  }) as never;

function ordersService(role: string) {
  const findUnique = jest.fn().mockResolvedValue({
    id: "o-1",
    status: "PENDING",
    customerId: "c-1",
    routeRun: { status: "DISPATCHED", startedAt: null, driverId: "d-1" },
    lineItems: [],
    registerKey: "reg-2",
    soldBy: { username: "pat" },
  });
  const service = Object.assign(Object.create(OrdersService.prototype), {
    prisma: {
      forTenant: () => ({
        order: { findUnique },
        customer: { findFirst: jest.fn().mockResolvedValue({ id: "c-1" }) },
        driver: { findFirst: jest.fn().mockResolvedValue({ id: "d-1" }) },
      }),
    },
  }) as OrdersService;
  return { findUnique, run: () => service.findOne("o-1", caller(role)) };
}

describe("OrdersService.findOne: the hand-over stamp (row 342)", () => {
  it.each(["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN"])(
    "%s: selects soldBy as the username only, and returns the built display name",
    async (role) => {
      const { findUnique, run } = ordersService(role);
      const out = (await run()) as unknown as Record<string, unknown>;
      expect(findUnique.mock.calls[0][0].include.soldBy).toEqual({ select: { username: true } });
      expect(out.registerKey).toBe("reg-2");
      expect(out.soldBy).toEqual({ username: "pat" });
      expect(out.handedOverBy).toBe("pat");
    },
  );

  it("an unstamped order reads handedOverBy null (never a guessed name)", async () => {
    const { findUnique, run } = ordersService("OPERATOR");
    findUnique.mockResolvedValueOnce({
      id: "o-1",
      status: "PENDING",
      customerId: "c-1",
      routeRun: null,
      lineItems: [],
      registerKey: null,
      soldBy: null,
    });
    const out = (await run()) as unknown as Record<string, unknown>;
    expect(out.handedOverBy).toBeNull();
    expect(out.registerKey).toBeNull(); // the client reads null as the default register
  });

  it.each(["CUSTOMER", "DRIVER"])(
    "%s: no cashier relation is read and no display name is built",
    async (role) => {
      const { findUnique, run } = ordersService(role);
      await run().catch(() => undefined);
      expect(findUnique.mock.calls[0][0].include).not.toHaveProperty("soldBy");
    },
  );

  it("a buyer's order projection (the allowlist) carries neither the register nor the cashier", () => {
    const out = toCustomerOrder({
      id: "o-1",
      orderNumber: "SO-1",
      status: "PENDING",
      total: 10,
      registerKey: "reg-2",
      soldById: "u-9",
      soldBy: { username: "pat" },
      handedOverBy: "pat",
    }) as Record<string, unknown>;
    expect(out).toMatchObject({ id: "o-1", orderNumber: "SO-1" });
    for (const key of ["registerKey", "soldById", "soldBy", "handedOverBy"]) {
      expect(out).not.toHaveProperty(key);
    }
  });
});

describe("seesHandOverStamp", () => {
  it("is staff only: not a buyer, a driver or no caller", () => {
    expect(seesHandOverStamp({ role: "OPERATOR" })).toBe(true);
    expect(seesHandOverStamp({ role: "TENANT_ADMIN" })).toBe(true);
    expect(seesHandOverStamp({ role: "CUSTOMER" })).toBe(false);
    expect(seesHandOverStamp({ role: "DRIVER" })).toBe(false);
    expect(seesHandOverStamp({})).toBe(false);
    expect(seesHandOverStamp(undefined)).toBe(false);
  });
});

// The module is mocked above (OrdersService imports it); the invoice read under test is the REAL class.
const RealInvoicesService: new (...a: unknown[]) => InvoicesService = jest.requireActual(
  "../invoices/invoices.service",
).InvoicesService;

function invoicesService() {
  const findUnique = jest.fn().mockResolvedValue({
    id: "inv-1",
    status: "SENT",
    total: 10,
    customerId: "c-1",
    dueDate: null,
    payments: [],
    items: [],
    order: {
      status: "DELIVERED",
      orderNumber: "SO-1",
      fulfillPath: "PICKUP",
      shippedAt: null,
      registerKey: "reg-2",
      soldBy: { username: "pat" },
    },
  });
  const service = new RealInvoicesService(...Array(14).fill(undefined));
  Object.assign(service, {
    prisma: {
      getTenantId: () => null,
      forTenant: () => ({
        invoice: { findUnique },
        auditLog: { groupBy: jest.fn().mockResolvedValue([]) },
        customer: { findFirst: jest.fn().mockResolvedValue({ id: "c-1" }) },
      }),
    },
    systemConfig: { get: jest.fn().mockResolvedValue(null) },
  });
  return { findUnique, service };
}

describe("InvoicesService.findOne: the hand-over stamp on the order stub (row 342)", () => {
  it("staff: the order stub selects registerKey + soldBy (username only) and carries handedOverBy", async () => {
    const { findUnique, service } = invoicesService();
    const out = (await service.findOne("inv-1", caller("OPERATOR"))) as unknown as {
      order: Record<string, unknown>;
    };
    const select = findUnique.mock.calls[0][0].include.order.select;
    expect(select).toMatchObject({
      status: true,
      orderNumber: true,
      fulfillPath: true,
      shippedAt: true,
      registerKey: true,
      soldBy: { select: { username: true } },
    });
    expect(out.order).toMatchObject({ registerKey: "reg-2", handedOverBy: "pat" });
  });

  it.each([
    ["a driver", caller("DRIVER")],
    ["a read with no caller (the buyer invoice route)", undefined],
  ])("%s: registerKey is read, the cashier relation is not", async (_n, user) => {
    const { findUnique, service } = invoicesService();
    await service.findOne("inv-1", user);
    const select = findUnique.mock.calls[0][0].include.order.select;
    expect(select.registerKey).toBe(true);
    expect(select).not.toHaveProperty("soldBy");
  });

  it("a buyer's invoice detail has no order stub at all (the allowlist names orderId only)", async () => {
    const { service } = invoicesService();
    const out = (await service.findOne("inv-1", caller("CUSTOMER"))) as unknown as Record<
      string,
      unknown
    >;
    expect(out).not.toHaveProperty("order");
    expect(JSON.stringify(out)).not.toContain("pat");
    const piped = pickCustomerInvoiceFields({
      id: "inv-1",
      order: { registerKey: "reg-2", soldBy: { username: "pat" }, handedOverBy: "pat" },
    }) as Record<string, unknown>;
    expect(piped).not.toHaveProperty("order");
  });
});
