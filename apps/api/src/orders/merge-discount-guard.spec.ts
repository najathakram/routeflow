import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { mergeBlockedByDiscount, orderMergeDiscounted } from "./merge-discount-guard";
import { readMergeGroup } from "./merge-lock-recheck";

/**
 * W-762 / SA-918 §2: a customer-level merge never runs while ANY participant (the winner included) carries an order
 * discount. Carrying Σ discounts onto the winner is SA-780's allocation question; until it is decided, an explicit merge
 * refuses (409 ORDER_MERGE_DISCOUNTED) and an automatic one skips (the orders stay separate).
 */
const order = (id: string, discountAmount: number | string | null, updatedAt = "2026-10-20") => ({
  id,
  discountAmount,
  updatedAt: new Date(`${updatedAt}T00:00:00.000Z`),
  fulfillPath: null,
  shipmentId: null,
  lineItems: [{ id: `${id}-l`, productId: "p1", status: "PENDING", qty: 1 }],
});
const db = (rows: any[]) => ({
  order: { findMany: jest.fn().mockResolvedValue(rows) },
  invoice: { findMany: jest.fn().mockResolvedValue([]) }, // force reads the losers' draft invoices
});

describe("mergeBlockedByDiscount (W-762, SA-918)", () => {
  it("is true when ANY participant has a positive discount — the winner included", () => {
    expect(mergeBlockedByDiscount([order("w", 5), order("l", 0)])).toBe(true);
    expect(mergeBlockedByDiscount([order("w", 0), order("l", "2.50")])).toBe(true);
  });
  it("is false when every participant's discount is zero or absent", () => {
    expect(mergeBlockedByDiscount([order("w", 0), order("l", null), order("x", "0.00")])).toBe(
      false,
    );
  });
  it("the refusal is a 409 with its own code and the ruling's sentence", () => {
    const e = orderMergeDiscounted();
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({
      code: API_ERROR_CODES.ORDER_MERGE_DISCOUNTED,
      message:
        "An order in this merge has an order discount. Merge them after removing it, or keep them separate.",
    });
  });
});

describe("readMergeGroup applies the guard (judged on the rows it reads, before any write)", () => {
  it("auto: a discounted participant empties the group, so the merge skips and nothing folds", async () => {
    const r = await readMergeGroup(db([order("w", 0), order("l", 3)]), "c1", "auto");
    expect(r.group).toEqual([]);
    expect(r.discounted).toBe(true);
  });
  it("auto: a discounted WINNER skips too", async () => {
    const r = await readMergeGroup(db([order("w", 4, "2026-10-21"), order("l", 0)]), "c1", "auto");
    expect(r.group).toEqual([]);
  });
  it("force: a discounted participant is the 409", async () => {
    await expect(
      readMergeGroup(db([order("w", 0), order("l", 3)]), "c1", "force"),
    ).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.ORDER_MERGE_DISCOUNTED },
    });
  });
  it("a single order is not a merge: a discounted lone order is returned untouched", async () => {
    const r = await readMergeGroup(db([order("w", 4)]), "c1", "auto");
    expect(r.group.map((o) => o.id)).toEqual(["w"]);
    expect(r.discounted).toBe(false);
  });
  it("no discount anywhere: the group is unchanged", async () => {
    const r = await readMergeGroup(db([order("w", 0), order("l", null)]), "c1", "auto");
    expect(r.group.map((o) => o.id)).toEqual(["w", "l"]);
    expect(r.discounted).toBe(false);
  });
});
