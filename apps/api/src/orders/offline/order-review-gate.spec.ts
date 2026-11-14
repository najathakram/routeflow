import { ConflictException } from "@nestjs/common";
import { OrderReviewFlagKind } from "@prisma/client";
import { ORDER_REVIEW_FLAG_KIND_VALUES } from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import {
  assertOrderReviewed,
  hasOpenReviewBlock,
  REVIEW_BLOCKING_KINDS,
} from "./order-review-gate";

/**
 * SA-1124 PR-1b: the ONE guard behind invoice send and staff payments. Only an open PRICE_CHANGED_OFFLINE flag blocks
 * (SA-817 section 5); every other kind is informational or clears at promotion. The fake `db` below honours the
 * query's `kind` and `resolvedAt` filters, so a wrong filter shows as a wrong answer, never as a passing mock.
 */
type Row = { orderId: string; kind: OrderReviewFlagKind; resolvedAt: Date | null };

function fakeDb(rows: Row[]) {
  const findMany = jest.fn(async (args: any) => {
    const w = args.where;
    return rows
      .filter((r) => r.orderId === w.orderId)
      .filter((r) => (w.kind?.in ? w.kind.in.includes(r.kind) : true))
      .filter((r) => (w.resolvedAt === null ? r.resolvedAt === null : true))
      .map((r) => ({ kind: r.kind }));
  });
  return { db: { orderReviewFlag: { findMany } }, findMany };
}

const open = (kind: OrderReviewFlagKind, orderId = "o1"): Row => ({
  orderId,
  kind,
  resolvedAt: null,
});

describe("REVIEW_BLOCKING_KINDS", () => {
  it("is exactly one kind, PRICE_CHANGED_OFFLINE (count-pinned: a second blocking kind is a decision)", () => {
    expect([...REVIEW_BLOCKING_KINDS]).toEqual([OrderReviewFlagKind.PRICE_CHANGED_OFFLINE]);
  });
});

describe("assertOrderReviewed", () => {
  it("throws 409 ORDER_REVIEW_REQUIRED with the order id and the open kinds while a price flag is open", async () => {
    const { db } = fakeDb([open(OrderReviewFlagKind.PRICE_CHANGED_OFFLINE)]);
    const err = await assertOrderReviewed(db, "o1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.ORDER_REVIEW_REQUIRED,
      orderId: "o1",
      openKinds: ["PRICE_CHANGED_OFFLINE"],
    });
  });

  it("passes once the flag is resolved", async () => {
    const { db } = fakeDb([
      { orderId: "o1", kind: OrderReviewFlagKind.PRICE_CHANGED_OFFLINE, resolvedAt: new Date() },
    ]);
    await expect(assertOrderReviewed(db, "o1")).resolves.toBeUndefined();
  });

  it("passes for an order with no flags and for another order's flag", async () => {
    const { db } = fakeDb([open(OrderReviewFlagKind.PRICE_CHANGED_OFFLINE, "other")]);
    await expect(assertOrderReviewed(db, "o1")).resolves.toBeUndefined();
  });

  it.each(ORDER_REVIEW_FLAG_KIND_VALUES.filter((k) => k !== "PRICE_CHANGED_OFFLINE"))(
    "an open %s flag alone never blocks",
    async (kind) => {
      const { db } = fakeDb([open(kind as OrderReviewFlagKind)]);
      await expect(assertOrderReviewed(db, "o1")).resolves.toBeUndefined();
      await expect(hasOpenReviewBlock(db, "o1")).resolves.toBe(false);
    },
  );

  it("a price flag blocks even beside informational flags, and openKinds names only the blocking kind", async () => {
    const { db } = fakeDb([
      open(OrderReviewFlagKind.BACKORDERED_OFFLINE),
      open(OrderReviewFlagKind.PRICE_CHANGED_OFFLINE),
      open(OrderReviewFlagKind.PRICE_CHANGED_OFFLINE),
    ]);
    const err = await assertOrderReviewed(db, "o1").catch((e) => e);
    expect(err.getResponse().openKinds).toEqual(["PRICE_CHANGED_OFFLINE"]);
  });

  it("reads only the order's open blocking rows (one indexed query)", async () => {
    const { db, findMany } = fakeDb([]);
    await assertOrderReviewed(db, "o1");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({
      orderId: "o1",
      kind: { in: [OrderReviewFlagKind.PRICE_CHANGED_OFFLINE] },
      resolvedAt: null,
    });
  });
});

describe("the optional tenant scope (a read on a client with no request context)", () => {
  it("adds tenantId to the where only when the caller names one", async () => {
    const { db, findMany } = fakeDb([]);
    await hasOpenReviewBlock(db, "o1", "t1");
    expect(findMany.mock.calls[0][0].where).toEqual({
      orderId: "o1",
      tenantId: "t1",
      kind: { in: [OrderReviewFlagKind.PRICE_CHANGED_OFFLINE] },
      resolvedAt: null,
    });
    await hasOpenReviewBlock(db, "o1");
    expect(findMany.mock.calls[1][0].where).not.toHaveProperty("tenantId");
  });
});

describe("hasOpenReviewBlock (the non-throwing form, for a step that must leave a DRAFT instead of failing)", () => {
  it("is true only while a price flag is open", async () => {
    expect(
      await hasOpenReviewBlock(fakeDb([open(OrderReviewFlagKind.PRICE_CHANGED_OFFLINE)]).db, "o1"),
    ).toBe(true);
    expect(await hasOpenReviewBlock(fakeDb([]).db, "o1")).toBe(false);
  });
});
