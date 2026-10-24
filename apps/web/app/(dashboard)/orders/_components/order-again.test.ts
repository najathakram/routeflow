import type { OrderSuggestionProduct, RecentOrderSummary } from "@routeflow/types";
import {
  ORDER_AGAIN_COPY,
  mergeOrderedIntoLine,
  orderAgainSummary,
  orderedQtyFields,
  planOrderAgain,
  repackMessage,
  unavailableMessage,
  unclearMessage,
} from "./order-again";

const product = (id: string, o: Partial<OrderSuggestionProduct> = {}): OrderSuggestionProduct => ({
  id,
  name: `Product ${id}`,
  variantName: null,
  parentProductId: null,
  parent: null,
  unit: "each",
  unitsPerBox: null,
  pricePerUnit: 5,
  priceTier2: 4,
  priceTier3: 3,
  priceTier4: 2,
  priceTier5: 1,
  averageCost: null,
  category: null,
  trackedCategoryId: null,
  isActive: true,
  ...o,
});

const line = (productId: string, o: Record<string, unknown> = {}) => ({
  productId,
  qty: 1,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  ...o,
});

const order = (lines: ReturnType<typeof line>[]): RecentOrderSummary => ({
  id: "o1",
  orderNumber: "ORD-1",
  date: "2026-09-28T00:00:00.000Z",
  status: "DELIVERED",
  lines,
});

describe("orderedQtyFields — quantity as ordered, normalised through @routeflow/pricing", () => {
  it("a plain product keeps its count and has no box split", () => {
    expect(orderedQtyFields(line("p1", { qty: 7 }), product("p1"))).toEqual({ qty: 7 });
  });

  it("a boxed line keeps its boxes and loose pieces (qty is total pieces)", () => {
    expect(
      orderedQtyFields(
        line("p1", { qty: 30, boxes: 2, pieces: 6, unitsPerBox: 12 }),
        product("p1", { unitsPerBox: 12 }),
      ),
    ).toEqual({ qty: 30, boxes: 2, pieces: 6 });
  });

  it("rolls loose pieces that reach a full box up into the box count", () => {
    expect(
      orderedQtyFields(
        line("p1", { qty: 14, boxes: 0, pieces: 14, unitsPerBox: 12 }),
        product("p1", { unitsPerBox: 12 }),
      ),
    ).toEqual({ qty: 14, boxes: 1, pieces: 2 });
  });

  it("uses the CURRENT pack size with the ordered boxes (a repack never re-reads old pieces)", () => {
    expect(
      orderedQtyFields(
        line("p1", { qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 }),
        product("p1", { unitsPerBox: 6 }),
      ),
    ).toEqual({ qty: 12, boxes: 2, pieces: 0 });
  });

  it("a pack of one is boxed too (web treats any non-zero unitsPerBox as boxed)", () => {
    expect(
      orderedQtyFields(
        line("p1", { qty: 3, boxes: 3, pieces: 0 }),
        product("p1", { unitsPerBox: 1 }),
      ),
    ).toEqual({ qty: 3, boxes: 3, pieces: 0 });
  });

  it("a legacy line with no stored split on a product that is boxed today is UNCLEAR, never read as boxes", () => {
    // 24 loose items must not become 24 boxes = 288 pieces at today's pack of 12.
    expect(orderedQtyFields(line("p1", { qty: 24 }), product("p1", { unitsPerBox: 12 }))).toBe(
      "unclear",
    );
    expect(orderedQtyFields(line("p1", { qty: 2 }), product("p1", { unitsPerBox: 12 }))).toBe(
      "unclear",
    );
  });

  it("a legacy line with no split on a product that is NOT boxed today is a plain count", () => {
    expect(orderedQtyFields(line("p1", { qty: 24 }), product("p1", { unitsPerBox: null }))).toEqual(
      {
        qty: 24,
      },
    );
  });

  it("a unit line (Carton) is a plain count of that unit, derived from its boxes", () => {
    expect(
      orderedQtyFields(
        line("p1", { qty: 48, boxes: 4, pieces: 0, unitsPerBox: 12, unitLabel: "Carton" }),
        product("p1", { unitsPerBox: 12 }),
      ),
    ).toEqual({ qty: 4 });
  });

  it("is null for a line that has nothing to order", () => {
    expect(orderedQtyFields(line("p1", { qty: 0 }), product("p1"))).toBeNull();
  });
});

describe("planOrderAgain", () => {
  it("plans each line's product, quantity and unit as ordered", () => {
    const plan = planOrderAgain(
      order([
        line("p1", { qty: 30, boxes: 2, pieces: 6, unitsPerBox: 12 }),
        line("p2", { qty: 48, boxes: 4, pieces: 0, unitsPerBox: 12, unitLabel: "Carton" }),
      ]),
      { p1: product("p1", { unitsPerBox: 12 }), p2: product("p2", { unitsPerBox: 12 }) },
    );
    expect(plan.unavailable).toBe(0);
    expect(plan.unclear).toBe(0);
    expect(plan.repacked).toBe(0);
    expect(plan.items.map((i) => [i.product.id, i.qty, i.unitLabel])).toEqual([
      ["p1", { qty: 30, boxes: 2, pieces: 6 }, undefined],
      ["p2", { qty: 4 }, "Carton"],
    ]);
  });

  it("skips inactive and missing products and counts them", () => {
    const plan = planOrderAgain(order([line("p1"), line("p2"), line("p3")]), {
      p1: product("p1"),
      p2: product("p2", { isActive: false }),
    });
    expect(plan.items.map((i) => i.product.id)).toEqual(["p1"]);
    expect(plan.unavailable).toBe(2);
  });

  it("skips a line whose quantity cannot be decided and counts it (never guesses)", () => {
    const plan = planOrderAgain(order([line("p1", { qty: 24 }), line("p2", { qty: 2 })]), {
      p1: product("p1", { unitsPerBox: 12 }),
      p2: product("p2"),
    });
    expect(plan.items.map((i) => [i.product.id, i.qty])).toEqual([["p2", { qty: 2 }]]);
    expect(plan.unclear).toBe(1);
    expect(plan.unavailable).toBe(0);
  });

  it("counts the lines whose pack size changed since they were ordered", () => {
    const plan = planOrderAgain(
      order([
        line("p1", { qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 }),
        line("p2", { qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 }),
      ]),
      { p1: product("p1", { unitsPerBox: 6 }), p2: product("p2", { unitsPerBox: 12 }) },
    );
    expect(plan.repacked).toBe(1);
    expect(plan.items[0].qty).toEqual({ qty: 12, boxes: 2, pieces: 0 });
  });

  it("carries no price: a plan item is a product, a quantity and a unit only", () => {
    const [item] = planOrderAgain(order([line("p1")]), { p1: product("p1") }).items;
    expect(Object.keys(item).sort()).toEqual(["product", "qty", "unitLabel"]);
  });
});

describe("mergeOrderedIntoLine — ordered quantity onto a line already on the order", () => {
  it("a boxed line gains pieces and rolls them up into boxes", () => {
    const merged = mergeOrderedIntoLine(
      { qty: 18, unitsPerBox: 12, boxes: 1, pieces: 6 },
      { qty: 30, boxes: 2, pieces: 6 },
    );
    expect(merged).toMatchObject({ qty: 48, boxes: 4, pieces: 0 });
  });

  it("a unit line adds its count; a plain line adds qty", () => {
    expect(mergeOrderedIntoLine({ qty: 2, unitLabel: "Carton" }, { qty: 3 }).qty).toBe(5);
    expect(mergeOrderedIntoLine({ qty: 2 }, { qty: 3 }).qty).toBe(5);
  });
});

describe("copy", () => {
  it("says how many items are no longer available", () => {
    expect(unavailableMessage(3)).toBe("3 items are no longer available");
    expect(unavailableMessage(1)).toBe("1 item is no longer available");
  });

  it("says how many items could not be added and how many have a new pack size", () => {
    expect(unclearMessage(1)).toBe("1 item could not be added because its quantity is unclear");
    expect(unclearMessage(2)).toBe(
      "2 items could not be added because their quantities are unclear",
    );
    expect(repackMessage(1)).toBe("1 item has a new pack size, so check its quantity");
    expect(repackMessage(3)).toBe("3 items have a new pack size, so check their quantities");
  });

  it("the button and prompt copy is fixed", () => {
    expect(ORDER_AGAIN_COPY.usuallyBuys).toBe("Usually buys");
    expect(ORDER_AGAIN_COPY.orderAgain).toBe("Order again");
    expect(ORDER_AGAIN_COPY.confirmLines).toBe(
      "This order already has lines. Add these lines as well?",
    );
  });

  it("summarises an order's lines by name and quantity", () => {
    expect(
      orderAgainSummary(
        order([
          line("p1", { qty: 30, boxes: 2, pieces: 6, unitsPerBox: 12 }),
          line("p2", { qty: 4, unitLabel: "Carton" }),
          line("p3", { qty: 2 }),
        ]),
        {
          p1: product("p1", { name: "Chips", unitsPerBox: 12 }),
          p2: product("p2", { name: "Soda" }),
          p3: product("p3", { name: "Gum", variantName: "Mint", parent: { name: "Brand" } }),
        },
      ),
    ).toBe("Chips × 2 boxes + 6 pcs, Soda × 4 Carton, Brand - Mint × 2");
  });
});
