import { deliveredBasisByLine } from "./delivered-basis-by-line";

describe("deliveredBasisByLine (round 7, SA-113b)", () => {
  // The DB-level pin for this exact scenario (recompute-order-partial.db.spec.ts, "(b)") doesn't
  // discriminate the bug in every direction: over-billing relative to a corrupted (too-low)
  // basis can still satisfy checkOrderCoverage's `>=` check either way. This unit test asserts
  // the EXACT basis value directly, which the old code got wrong (7 + -3 = 4, not 7).
  it("an ADD_ON row's signed qty never contributes to a line's basis, even alongside a real DELIVERED row", async () => {
    const db = {
      deliveryMutation: {
        findMany: jest.fn().mockResolvedValue([
          { orderItemId: "li1", type: "ADD_ON", quantityDelivered: null, qty: -3 },
          { orderItemId: "li1", type: "DELIVERED", quantityDelivered: 7, qty: null },
        ]),
      },
    };

    const basis = await deliveredBasisByLine(db as any, "order1");

    expect(basis.byLineId.get("li1")).toBe(7);
  });

  it("a REMOVE_ITEM-shaped row (REFUSED, no quantityDelivered) never counts as evidence", async () => {
    const db = {
      deliveryMutation: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { orderItemId: "li1", type: "REFUSED", quantityDelivered: null, qty: -10 },
          ]),
      },
    };

    const basis = await deliveredBasisByLine(db as any, "order1");

    expect(basis.hasMutations).toBe(false);
    expect(basis.byLineId.size).toBe(0);
  });
});
