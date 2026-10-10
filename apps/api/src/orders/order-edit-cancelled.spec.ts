import { ConflictException, ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import {
  LINE_CANCELLED_BY_SELLER,
  assertHeldCancelledLines,
  liveLines,
  planCancelledLines,
  sellerCancelledOnly,
} from "./order-edit-cancelled";

/**
 * SA-422 (#2320) — a buyer order edit must never revive a seller-CANCELLED line. Buyer replace path:
 * a product whose only lines are CANCELLED ⇒ 409 LINE_CANCELLED_BY_SELLER, zero writes; a live
 * sibling of the same product is an ordinary echo. Diff path (buyer after #2286, DRIVER today): any
 * action other than CANCEL/DELETE on a cancelled id ⇒ the same 409; CANCEL/DELETE on it ⇒ a no-op.
 * (Real-Postgres pins for the same ruling: buyer-edit-cancelled-line.db.spec.ts, run by F2.)
 */

const cancelledCase = { id: "li-x", productId: "p-cola", status: "CANCELLED" };
const liveChips = { id: "li-c", productId: "p-chips", status: "PENDING" };
const order = { id: "o1", customerId: "cust-1", lineItems: [cancelledCase, liveChips] };
const buyer = { role: UserRole.CUSTOMER, sub: "u-b" };
const driver = { role: UserRole.DRIVER, sub: "u-d" };
const staff = { role: UserRole.OPERATOR, sub: "u-o" };

const prismaWith = (owner: { id: string } | null) =>
  ({
    forTenant: () => ({
      customer: { findFirst: jest.fn().mockResolvedValue(owner) },
      product: { findFirst: jest.fn().mockResolvedValue({ name: "Cola 12pk" }) },
    }),
  }) as any;
const owned = prismaWith({ id: "cust-1" });

describe("sellerCancelledOnly / liveLines (SA-422)", () => {
  it("a product with a CANCELLED line and no live line is seller-cancelled; a live sibling clears it", () => {
    expect([...sellerCancelledOnly(order.lineItems)]).toEqual(["p-cola"]);
    expect([
      ...sellerCancelledOnly([
        ...order.lineItems,
        { id: "li-y", productId: "p-cola", status: "PENDING" },
      ]),
    ]).toEqual([]);
  });

  it("liveLines drops CANCELLED rows only", () => {
    expect(liveLines(order.lineItems)).toEqual([liveChips]);
  });
});

describe("planCancelledLines — buyer replace path (SA-422 rule 2)", () => {
  it("naming a seller-cancelled product is a 409 LINE_CANCELLED_BY_SELLER with the product named", async () => {
    const dto = {
      items: [
        { productId: "p-cola", qty: 24 },
        { productId: "p-chips", qty: 1 },
      ],
    };
    const err = await planCancelledLines(owned, order, dto as any, buyer, false).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: LINE_CANCELLED_BY_SELLER,
      productId: "p-cola",
    });
    expect(err.getResponse().message).toContain("Cola 12pk");
  });

  it("a non-owner meets the bare 403 before any product is named", async () => {
    const dto = { items: [{ productId: "p-cola", qty: 24 }] };
    await expect(
      planCancelledLines(prismaWith({ id: "someone" }), order, dto as any, buyer, false),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("an echo of live products passes untouched", async () => {
    const dto = { items: [{ productId: "p-chips", qty: 2 }] };
    await expect(planCancelledLines(owned, order, dto as any, buyer, false)).resolves.toEqual({
      noop: false,
    });
    expect(dto.items).toEqual([{ productId: "p-chips", qty: 2 }]);
  });

  it("a DRIVER's replace payload and every staff payload are out of scope (unchanged)", async () => {
    const dto = { items: [{ productId: "p-cola", qty: 24 }] };
    await expect(planCancelledLines(owned, order, dto as any, driver, false)).resolves.toEqual({
      noop: false,
    });
    await expect(planCancelledLines(owned, order, dto as any, staff, false)).resolves.toEqual({
      noop: false,
    });
  });
});

describe("planCancelledLines — diff path (SA-422 rule 4)", () => {
  it("an UPDATE on a cancelled id is the same 409, for a DRIVER and a buyer", async () => {
    for (const who of [driver, buyer]) {
      const dto = { replaceAll: false, items: [{ id: "li-x", qty: 3 }] };
      await expect(planCancelledLines(owned, order, dto as any, who, true)).rejects.toMatchObject({
        response: { code: LINE_CANCELLED_BY_SELLER, productId: "p-cola" },
      });
    }
  });

  it("CANCEL/DELETE on a cancelled id is dropped; a diff of only those is a no-op", async () => {
    const dto = { replaceAll: false, items: [{ id: "li-x", action: "CANCEL" }] };
    await expect(planCancelledLines(owned, order, dto as any, driver, true)).resolves.toEqual({
      noop: true,
    });
    const mixed = {
      replaceAll: false,
      items: [
        { id: "li-x", action: "DELETE" },
        { id: "li-c", qty: 2 },
      ],
    };
    await expect(planCancelledLines(owned, order, mixed as any, driver, true)).resolves.toEqual({
      noop: false,
    });
    expect(mixed.items).toEqual([{ id: "li-c", qty: 2 }]);
  });

  it("SA-422a: a NON-OWNER buyer's strike-off-only diff is a 403, never the order read back", async () => {
    const dto = { replaceAll: false, items: [{ id: "li-x", action: "CANCEL" }] };
    await expect(
      planCancelledLines(prismaWith({ id: "someone" }), order, dto as any, buyer, true),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      planCancelledLines(
        owned,
        order,
        { replaceAll: false, items: [{ id: "li-x", action: "CANCEL" }] } as any,
        buyer,
        true,
      ),
    ).resolves.toEqual({
      noop: true,
    });
  });

  it("Opus N1: a strike-off-only diff that ALSO carries an inlineReturn is not a no-op (the return runs)", async () => {
    const dto: any = {
      replaceAll: false,
      items: [{ id: "li-x", action: "CANCEL" }],
      inlineReturn: { items: [{ productId: "p-chips", qty: 1 }], returnKey: "k1" },
    };
    await expect(planCancelledLines(owned, order, dto, driver, true)).resolves.toEqual({
      noop: false,
    });
    expect(dto.items).toEqual([]);
  });

  it("staff diffs are unchanged", async () => {
    const dto = { replaceAll: false, items: [{ id: "li-x", qty: 3 }] };
    await expect(planCancelledLines(owned, order, dto as any, staff, true)).resolves.toEqual({
      noop: false,
    });
  });
});

describe("assertHeldCancelledLines — the same rules re-checked under the row lock", () => {
  it("refuses when the seller cancelled the product's last live line while the edit waited", () => {
    const held = [cancelledCase, { ...liveChips, status: "CANCELLED" }];
    expect(() =>
      assertHeldCancelledLines(held, [{ productId: "p-chips", qty: 1 }], buyer, false),
    ).toThrow(ConflictException);
    expect(() =>
      assertHeldCancelledLines(order.lineItems, [{ productId: "p-chips", qty: 1 }], buyer, false),
    ).not.toThrow();
  });
});

describe("SA-422b — the cancelled-line rules run before any unit check", () => {
  it("(a) updateOrderItems: CANCELLED-order 400 → classify → planCancelledLines → unit guard → unit loop", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const src: string = fs.readFileSync(path.join(__dirname, "orders.service.ts"), "utf8");
    const body = src.slice(src.indexOf("async updateOrderItems("));
    const at = (needle: string) => {
      const i = body.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at(`"Items can't be edited on a cancelled order"`),
      at("classifyEditPayload(order, dto, user)"),
      at("cancelledLines.planCancelledLines("),
      at("unitAware.assertOrderEditAllowed("),
      at("unitEdit.prepareUnitEditContext("),
    ];
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("(b) prepareUnitEditContext: a CANCELLED unit line's id is absent for a NON-staff caller, kept for staff (Opus item 6)", async () => {
    const { prepareUnitEditContext } =
      require("./unit-line-edit") as typeof import("./unit-line-edit");
    const self = {
      prisma: {
        getTenantId: () => "t1",
        forTenant: () => ({
          product: { findMany: jest.fn().mockResolvedValue([]) },
          productUnit: { findMany: jest.fn().mockResolvedValue([]) },
        }),
      },
      entitlements: { hasFlag: jest.fn().mockResolvedValue(true) },
    } as any;
    const lines = [
      { id: "li-x", productId: "p1", unitLabel: "Case", unitsPerBox: 12, status: "CANCELLED" },
      { id: "li-l", productId: "p2", unitLabel: null, unitsPerBox: 6, status: "PENDING" },
    ];
    const forRole = (role: string) =>
      prepareUnitEditContext(self, { lineItems: lines } as any, { items: [] } as any, { role });
    const driverCtx = await forRole("DRIVER");
    expect(driverCtx.existingById.has("li-x")).toBe(false);
    expect(driverCtx.existingById.has("li-l")).toBe(true);
    const staffCtx = await forRole("OPERATOR");
    expect(staffCtx.existingById.has("li-x")).toBe(true);
  });
});
