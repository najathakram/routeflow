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
