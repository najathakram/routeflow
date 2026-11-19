// SA-434: these driver cases pin OTHER behaviour; ownership is pinned in driver-edit-access*.spec.ts.
jest.mock("./driver-edit-access", () => ({
  ...jest.requireActual("./driver-edit-access"),
  assertDriverMayEditOrder: jest.fn(),
}));
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { Test } from "@nestjs/testing";
import { BadRequestException, Logger } from "@nestjs/common";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { checkQtySplitConsistency } from "./qty-split-consistency";
import { ChangeRequestsService } from "./change-requests.service";
import { OrdersService } from "./orders.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { MessagingService } from "../messaging/messaging.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B729 round 2 / SA-1173: the at-stop approval of a customer ADD_ITEM (K1/K2), the filing check (K3), the `upb !== undefined`
 * gate (K4) and the sorted pin over the enforce sites (K5).
 */
describe("SA-1173 K2: the approver gets its own refusal (T1)", () => {
  const driver = { ...operatorPayload, role: "DRIVER" } as never;
  const PLAIN = {
    id: "plain",
    name: "Sample Plain",
    pricePerUnit: 2,
    unitsPerBox: null,
    category: null,
    trackedCategoryId: null,
  };
  const STORED = {
    id: "li-1",
    orderId: "ord-1",
    productId: "plain",
    qty: 12,
    boxes: 1,
    pieces: 0,
    unitsPerBox: 12,
    unitPrice: 2,
    subtotal: 24,
    status: "PENDING",
    deliveredQty: 0,
    trackedCategoryId: null,
  };
  const order = {
    id: "ord-1",
    customerId: "cust-1",
    orderNumber: "ORD-123",
    status: "OUT_FOR_DELIVERY",
    subtotal: 24,
    tax: 0,
    total: 24,
    routeRunId: "run-1",
    routeRunStopId: "stop-1",
    lineItems: [STORED],
    routeRun: { id: "run-1", status: "IN_PROGRESS", driverId: "drv-1" },
    routeRunStop: { id: "stop-1", status: "PENDING" },
  };
  const cr = (role: string) => ({
    id: "cr-1",
    tenantId: "test-tenant",
    orderId: "ord-1",
    orderItemId: null,
    productId: "plain",
    routeRunStopId: "stop-1",
    type: "ADD_ITEM",
    status: "PENDING",
    payload: { productId: "plain", qty: 3, boxes: 2, pieces: 0 },
    note: null,
    requestedById: "user-x",
    requestedByName: "someone",
    requestedByRole: role,
  });

  const arrange = async (role: string) => {
    const h = await buildOrdersService();
    h.prisma.changeRequest.findUnique.mockResolvedValue(cr(role));
    h.prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.customer.findUnique.mockResolvedValue({ creditLimit: null, pricingTier: 1 });
    h.prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1, creditLimit: null });
    h.prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    h.prisma.product.findUnique.mockResolvedValue(PLAIN);
    h.prisma.product.findFirst.mockResolvedValue(PLAIN);
    h.prisma.order.findUnique.mockResolvedValue(order);
    h.prisma.orderItem.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ ...STORED, trackedCategoryId: null }]);
    h.prisma.orderItem.findUnique.mockResolvedValue(STORED);
    return h;
  };

  it("T1: a CUSTOMER {qty 3, boxes 2} on a no-pack product is a 409 CHANGE_REQUEST_SPLIT_MISMATCH and bills nothing", async () => {
    const h = await arrange("CUSTOMER");
    await expect(h.service.approveChangeRequestAtStop("cr-1", driver, null)).rejects.toMatchObject({
      status: 409,
      response: {
        code: "CHANGE_REQUEST_SPLIT_MISMATCH",
        message:
          "This request's quantity and box count don't match, so it can't be applied: decline it.",
      },
    });
    expect(h.prisma.orderItem.update).not.toHaveBeenCalled();
    expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
  });

  it("T1b: the same input from a DRIVER is not refused with the K2 code (staff stay in warn mode)", async () => {
    const h = await arrange("DRIVER");
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const err = await h.service.approveChangeRequestAtStop("cr-1", driver, null).then(
        () => null,
        (e: { response?: { code?: string } }) => e,
      );
      expect(err?.response?.code).not.toBe("CHANGE_REQUEST_SPLIT_MISMATCH");
    } finally {
      warn.mockRestore();
    }
  });

  it("the K2 code lives in API_ERROR_CODES", () => {
    expect((API_ERROR_CODES as Record<string, string>).CHANGE_REQUEST_SPLIT_MISMATCH).toBe(
      "CHANGE_REQUEST_SPLIT_MISMATCH",
    );
  });

  it("K2: a caller's refuse factory replaces the buyer 400 and nothing else", () => {
    const line = { productId: "p", qty: 3, boxes: 2, pieces: 0 };
    class Mine extends Error {}
    expect(() =>
      checkQtySplitConsistency({
        mode: "enforce",
        path: "x",
        items: [line],
        upbFor: () => 12,
        refuse: () => new Mine("mine"),
      }),
    ).toThrow(Mine);
    expect(() =>
      checkQtySplitConsistency({ mode: "enforce", path: "x", items: [line], upbFor: () => 12 }),
    ).toThrow(BadRequestException);
  });
});

describe("SA-1173 K4: the enforce gate is `!== undefined`", () => {
  it("an enforce site whose pack lookup returns null refuses a contradictory split (null is a known no-pack product)", () => {
    expect(() =>
      checkQtySplitConsistency({
        mode: "enforce",
        path: "x",
        items: [{ productId: "p", qty: 3, boxes: 2, pieces: 0 }],
        upbFor: () => null,
      }),
    ).toThrow(BadRequestException);
  });

  it("undefined (unknown product) is still not refused here", () => {
    expect(
      checkQtySplitConsistency({
        mode: "enforce",
        path: "x",
        items: [{ productId: "p", qty: 3, boxes: 2, pieces: 0 }],
        upbFor: () => undefined,
      }),
    ).toEqual([]);
  });
});

describe("SA-1173 K3: filing an ADD_ITEM checks the split at the live pack (T3)", () => {
  const order = {
    id: "ord-1",
    customerId: "cust-1",
    orderNumber: "ORD-100",
    status: "OUT_FOR_DELIVERY" as const,
    routeRunId: "run-1",
    routeRunStopId: "stop-1",
    lineItems: [],
    routeRun: { status: "IN_PROGRESS" as const },
  };
  const PLAIN = {
    id: "plain",
    name: "Sample Plain",
    isActive: true,
    kind: "STANDARD",
    portalVisible: true,
    parent: null,
    unitsPerBox: null,
  };
  const customer = {
    sub: "u1",
    username: "buyer1",
    role: "CUSTOMER" as const,
    status: "ACTIVE" as const,
    forcePasswordChange: false,
    tenantId: "test-tenant",
    tenantSlug: "test",
  };
  const staff = { ...customer, role: "OPERATOR" as const };

  const build = async () => {
    const prisma = createMockPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChangeRequestsService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrdersService, useValue: {} },
        { provide: NotificationsService, useValue: { sendToCustomer: jest.fn() } },
        { provide: AuthorizationGuardService, useValue: {} },
        {
          provide: MessagingService,
          useValue: {
            notify: jest.fn().mockResolvedValue([]),
            notifyEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SellingRestrictionsService,
          useValue: {
            restrictedProductIdsFor: jest.fn().mockResolvedValue(new Set()),
            assertLinesSellable: jest.fn(),
          },
        },
      ],
    }).compile();
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.product.findFirst.mockResolvedValue(PLAIN);
    prisma.changeRequest.create.mockResolvedValue({ id: "cr-new", status: "PENDING" });
    return { prisma, service: moduleRef.get(ChangeRequestsService) };
  };
  const dto = { type: "ADD_ITEM" as never, productId: "plain", qty: 3, boxes: 2, pieces: 0 };

  it("T3: a buyer filing {3, boxes 2} on a no-pack product is a 400 and no request row", async () => {
    const { prisma, service } = await build();
    await expect(service.create("ord-1", dto, customer)).rejects.toMatchObject({
      status: 400,
      response: { code: "QTY_SPLIT_MISMATCH" },
    });
    expect(prisma.changeRequest.create).not.toHaveBeenCalled();
  });

  it("T3: the pack is read live through the shared live-pack lookup (one findMany on unitsPerBox), not a direct product read", async () => {
    const { prisma, service } = await build();
    await service.create("ord-1", { ...dto, boxes: undefined, pieces: undefined }, customer);
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, unitsPerBox: true } }),
    );
    expect(prisma.product.findFirst.mock.calls[0][0].select.unitsPerBox).toBeUndefined();
  });

  it("T3b: staff filing a contradictory split (at a 12-pack: warn mode only logs on a boxed product) is created, with one warn line", async () => {
    const { prisma, service } = await build();
    prisma.product.findMany.mockResolvedValue([{ id: PLAIN.id, unitsPerBox: 12 }]);
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      await service.create("ord-1", dto, staff);
      expect(prisma.changeRequest.create).toHaveBeenCalledTimes(1);
      const lines = warn.mock.calls.filter((c) => String(c[0]).includes("path=orders.cr.file"));
      expect(lines).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("a consistent buyer filing (no split) is still created", async () => {
    const { prisma, service } = await build();
    await service.create("ord-1", { ...dto, boxes: undefined, pieces: undefined }, customer);
    expect(prisma.changeRequest.create).toHaveBeenCalledTimes(1);
  });
});

describe("SA-1173 K5: the enforce sites are a closed, sorted list", () => {
  const SRC = join(__dirname, "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });
  it("every production call of checkQtySplitConsistency, with the path and mode it names", () => {
    const sites: string[] = [];
    for (const f of walk(SRC).filter((p) => !/\.(spec|test)\.ts$/.test(p))) {
      if (f.endsWith("qty-split-consistency.ts")) continue;
      const src = readFileSync(f, "utf8");
      const rel = f
        .slice(SRC.length + 1)
        .split("\\")
        .join("/");
      for (const m of src.matchAll(/checkQtySplitConsistency\(\{[\s\S]*?\n\s*\}\);/g)) {
        const pm = /\bpath(?::\s*([^,\n]+))?[,\n]/.exec(m[0]);
        const pathText = pm ? (pm[1] ?? "path") : "?";
        const mode = /mode:\s*([^,\n]+)/.exec(m[0])?.[1] ?? "?";
        sites.push(`${rel} | ${pathText} | ${mode}`);
      }
    }
    expect(sites.sort()).toEqual(
      [
        'buyer/buyer-qty-split.ts | path | "enforce"',
        'orders/change-requests.service.ts | "orders.cr.file" | splitModeFor(user.role)',
        'orders/orders.service.ts | "orders.cr.add.merge" | splitModeFor(cr.requestedByRole)',
      ].sort(),
    );
  });
});
