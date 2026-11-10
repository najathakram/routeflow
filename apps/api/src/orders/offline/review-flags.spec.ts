import { OrderReviewFlagKind } from "@prisma/client";
import { ORDER_REVIEW_FLAG_KIND_VALUES } from "@routeflow/types";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import {
  assertPromotionCredit,
  GATE_FLAG_KINDS,
  MANUAL_FLAG_KINDS,
  needsReviewWhere,
  NEEDS_REVIEW_WHERE,
  PASSED_AT_PROMOTION,
  resolveGateFlagsAtPromotion,
  resolveReviewFlag,
  seesReviewFlags,
} from "./review-flags";

const staff = { sub: "u1", role: "OPERATOR", tenantId: "t1" } as JwtPayload;

describe("review flag kinds", () => {
  it("every kind is manual or clears at promotion, none both (a new kind must be placed on purpose)", () => {
    const all = [...MANUAL_FLAG_KINDS, ...GATE_FLAG_KINDS].map(String).sort();
    expect(all).toEqual([...ORDER_REVIEW_FLAG_KIND_VALUES].sort());
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("seesReviewFlags", () => {
  it("staff only: never a buyer, a driver or no caller", () => {
    for (const role of ["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN"]) {
      expect(seesReviewFlags({ role })).toBe(true);
    }
    for (const role of ["CUSTOMER", "DRIVER"]) expect(seesReviewFlags({ role })).toBe(false);
    expect(seesReviewFlags(null)).toBe(false);
  });
});

describe("needsReviewWhere", () => {
  it("filters for staff when true, and never for a customer or when not true", () => {
    expect(needsReviewWhere(true, staff)).toBe(NEEDS_REVIEW_WHERE);
    expect(needsReviewWhere(true, { ...staff, role: "CUSTOMER" } as JwtPayload)).toEqual({});
    expect(needsReviewWhere(undefined, staff)).toEqual({});
    expect(needsReviewWhere(false, staff)).toEqual({});
  });
});

describe("assertPromotionCredit (SA-1124 item 6)", () => {
  const order = { id: "o1", customerId: "c1", total: "22.004" };
  const prismaWith = (count: jest.Mock) =>
    ({ forTenant: () => ({ orderReviewFlag: { count } }) }) as never;

  it("a plain draft (no open CREDIT_BLOCKED flag) never runs the credit gate", async () => {
    const gate = jest.fn();
    await assertPromotionCredit(prismaWith(jest.fn().mockResolvedValue(0)), order, gate, staff);
    expect(gate).not.toHaveBeenCalled();
  });

  it("a draft carrying one runs it with the order's total, excluding the order itself", async () => {
    const gate = jest.fn().mockResolvedValue(undefined);
    await assertPromotionCredit(prismaWith(jest.fn().mockResolvedValue(1)), order, gate, staff);
    expect(gate).toHaveBeenCalledWith({
      customerId: "c1",
      projectedTotal: 22,
      excludeOrderId: "o1",
      principal: staff,
    });
  });

  it("the gate's refusal propagates", async () => {
    const gate = jest.fn().mockRejectedValue(new Error("over limit"));
    const run = assertPromotionCredit(
      prismaWith(jest.fn().mockResolvedValue(1)),
      order,
      gate,
      staff,
    );
    await expect(run).rejects.toThrow("over limit");
  });

  it("reads only the open CREDIT_BLOCKED flags of this order", async () => {
    const count = jest.fn().mockResolvedValue(0);
    await assertPromotionCredit(prismaWith(count), order, jest.fn(), staff);
    expect(count).toHaveBeenCalledWith({
      where: { orderId: "o1", kind: OrderReviewFlagKind.CREDIT_BLOCKED, resolvedAt: null },
    });
  });
});

describe("resolveGateFlagsAtPromotion", () => {
  it("resolves only the open gate kinds of this order and tenant, with the actor and the fixed note", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    await resolveGateFlagsAtPromotion(
      { orderReviewFlag: { updateMany } },
      { id: "o1", tenantId: "t1" },
      "u1",
    );
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      orderId: "o1",
      tenantId: "t1",
      kind: { in: ["RESTRICTED", "LICENSE_REQUIRED", "CREDIT_BLOCKED"] },
      resolvedAt: null,
    });
    expect(arg.data).toMatchObject({ resolvedById: "u1", resolution: PASSED_AT_PROMOTION });
    expect(arg.data.resolvedAt).toBeInstanceOf(Date);
    expect(PASSED_AT_PROMOTION).toBe("passed at promotion");
  });
});

describe("resolveGateFlagsAtPromotion with no tenant on the order", () => {
  it("still scopes to the order id (one order, one tenant) and adds no null tenant filter", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    await resolveGateFlagsAtPromotion(
      { orderReviewFlag: { updateMany } },
      { id: "o1", tenantId: null },
      null,
    );
    expect(updateMany.mock.calls[0][0].where).not.toHaveProperty("tenantId");
    expect(updateMany.mock.calls[0][0].where.orderId).toBe("o1");
  });
});

describe("resolveReviewFlag", () => {
  const flag = (over: object = {}) => ({
    id: "f1",
    orderId: "o1",
    tenantId: "t1",
    kind: "PRICE_CHANGED_OFFLINE",
    resolvedAt: null,
    resolution: null,
    resolvedBy: null,
    ...over,
  });
  const world = (found: object | null) => {
    const db = {
      findFirst: jest.fn().mockResolvedValue(found),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ ...found, resolvedAt: new Date() }),
    };
    const prisma = { forTenant: () => ({ orderReviewFlag: db }), getTenantId: () => "t1" };
    return { db, prisma: prisma as never };
  };
  const call = (prisma: never, resolution = "Checked with the customer", user = staff) =>
    resolveReviewFlag(prisma, { orderId: "o1", flagId: "f1", resolution, user });

  it("looks the flag up by id, order AND tenant: nothing found is a 404", async () => {
    const { db, prisma } = world(null);
    await expect(call(prisma)).rejects.toMatchObject({ status: 404 });
    expect(db.findFirst.mock.calls[0][0].where).toEqual({
      id: "f1",
      orderId: "o1",
      tenantId: "t1",
    });
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it("an already-resolved flag returns as it is, writes nothing, whatever its kind", async () => {
    const done = flag({
      kind: "RESTRICTED",
      resolvedAt: new Date(),
      resolution: "passed at promotion",
    });
    const { db, prisma } = world(done);
    await expect(call(prisma)).resolves.toBe(done);
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it.each(["RESTRICTED", "LICENSE_REQUIRED", "CREDIT_BLOCKED"])(
    "%s is 409 ORDER_REVIEW_FLAG_NOT_MANUAL",
    async (kind) => {
      const { db, prisma } = world(flag({ kind }));
      const e: any = await call(prisma).catch((x) => x);
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse().code).toBe("ORDER_REVIEW_FLAG_NOT_MANUAL");
      expect(db.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(["PRICE_CHANGED_OFFLINE", "OPEN_ORDER_EXISTS", "BACKORDERED_OFFLINE"])(
    "%s resolves with a compare-and-set on the open row",
    async (kind) => {
      const { db, prisma } = world(flag({ kind }));
      await call(prisma, "  Checked with the customer  ");
      const arg = db.updateMany.mock.calls[0][0];
      expect(arg.where).toMatchObject({
        id: "f1",
        orderId: "o1",
        tenantId: "t1",
        resolvedAt: null,
      });
      expect(arg.data).toMatchObject({
        resolvedById: "u1",
        resolution: "Checked with the customer",
      });
    },
  );

  it("a note outside 3 to 500 characters is a 400 and writes nothing", async () => {
    for (const note of ["  ab ", "x".repeat(501)]) {
      const { db, prisma } = world(flag());
      await expect(call(prisma, note)).rejects.toMatchObject({ status: 400 });
      expect(db.updateMany).not.toHaveBeenCalled();
    }
  });

  it("a caller with no tenant is refused rather than reading unscoped", async () => {
    const { db } = world(flag());
    const noTenant = {
      forTenant: () => ({ orderReviewFlag: db }),
      getTenantId: () => null,
    } as never;
    const user = { ...staff, tenantId: null } as JwtPayload;
    await expect(call(noTenant, "Checked it", user)).rejects.toMatchObject({ status: 403 });
    expect(db.findFirst).not.toHaveBeenCalled();
  });
});
