import { priceReorderReview } from "./buyer-reorder-review";
import type { BuyerOrderTemplate } from "@/lib/api/buyer";

function item(
  id: string,
  productId: string,
  qty: number,
  extra: { suspendedAt?: string | null } = {},
): BuyerOrderTemplate["items"][number] {
  return {
    id,
    productId,
    qty,
    notes: null,
    product: { id: productId, name: `Product ${productId}`, unit: "box" },
    ...extra,
  };
}

function template(items: BuyerOrderTemplate["items"]): BuyerOrderTemplate {
  return {
    id: "t1",
    name: "Weekly",
    isActive: true,
    daysOfWeek: [1],
    notes: null,
    nextFireDate: null,
    items,
    customer: { id: "c1", businessName: "Corner Shop" },
  };
}

const catalog = [
  { id: "p1", buyerPrice: 30, category: null, unitsPerBox: 12 },
  { id: "p2", buyerPrice: 2.5, category: "Snacks", unitsPerBox: null },
];

describe("priceReorderReview", () => {
  it("prices a boxed line at the BOX price x boxes — never re-multiplied by unitsPerBox", () => {
    const r = priceReorderReview(template([item("i1", "p1", 2)]), catalog, []);
    expect(r.lines[0].lineSubtotal).toBe(60);
    expect(r.subtotal).toBe(60);
  });

  it("rounds the total to cents", () => {
    const r = priceReorderReview(
      template([item("i1", "p2", 3), item("i2", "p2", 1)]),
      [{ id: "p2", buyerPrice: 0.1, category: null, unitsPerBox: null }],
      [],
    );
    expect(r.subtotal).toBe(0.4);
  });

  it("applies a BUY_N_GET_M promotion's free units to the line total", () => {
    const r = priceReorderReview(template([item("i1", "p2", 6)]), catalog, [
      {
        id: "promo1",
        type: "BUY_N_GET_M",
        value: 1,
        minQty: 5,
        scope: "ALL",
        category: null,
        productIds: [],
      } as never,
    ]);
    expect(r.lines[0].freeUnits).toBe(1);
    expect(r.lines[0].lineSubtotal).toBe(12.5);
  });

  it("leaves an unpriceable line out of the total (never $0) and counts it", () => {
    const r = priceReorderReview(
      template([item("i1", "p2", 2), item("i2", "gone", 4)]),
      catalog,
      [],
    );
    expect(r.unresolvedCount).toBe(1);
    expect(r.lines[1].lineSubtotal).toBeNull();
    expect(r.subtotal).toBe(5);
  });

  it("drops a suspended line — the server never places it", () => {
    const r = priceReorderReview(
      template([item("i1", "p2", 2), item("i2", "p1", 1, { suspendedAt: "2026-10-01T00:00:00Z" })]),
      catalog,
      [],
    );
    expect(r.lines.map((l) => l.id)).toEqual(["i1"]);
    expect(r.subtotal).toBe(5);
  });
});

import { reorderNoneAvailable, reorderSkippedNote } from "./buyer-reorder-review";

describe("reorderSkippedNote (state portal limits)", () => {
  it("is null when nothing was skipped (skipped is always present, [] when none)", () => {
    expect(reorderSkippedNote({ id: "o1", skipped: [] })).toBeNull();
    expect(reorderSkippedNote({ id: "o1" })).toBeNull();
    expect(reorderSkippedNote(undefined)).toBeNull();
  });
  it("counts what was left out of a placed order", () => {
    expect(
      reorderSkippedNote({
        id: "o1",
        skipped: [
          { productId: "a", name: "A" },
          { productId: "b", name: "B" },
        ],
      }),
    ).toBe("2 items aren't available to you and were left out.");
    expect(reorderSkippedNote({ id: "o1", skipped: [{ productId: "a", name: "A" }] })).toBe(
      "1 item isn't available to you and was left out.",
    );
  });
});

describe("reorderNoneAvailable", () => {
  const e = (status: number, message: string) => ({ response: { status, data: { message } } });
  it("recognises the API's 400 for a reorder with nothing orderable and shows its sentence as-is", () => {
    expect(
      reorderNoneAvailable(e(400, "None of these items are available to you right now.")),
    ).toBe("None of these items are available to you right now.");
  });
  it("is null for any other failure", () => {
    expect(reorderNoneAvailable(e(400, "Something else"))).toBeNull();
    expect(
      reorderNoneAvailable(e(500, "None of these items are available to you right now.")),
    ).toBeNull();
    expect(reorderNoneAvailable(new Error("net"))).toBeNull();
  });
});
