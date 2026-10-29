import * as iGate from "./invoice-restriction-gate";

/**
 * W-748 Q2 (SA-1017): a DRAFT item edit keys each netted product on the first payload entry of that product that
 * names no existing line (the line the edit ADDS), so the warning points at what the user just added. A product with
 * no such entry keeps the old key: the first entry (`l:<id>` or `n:<index>`).
 */
const sale = { fulfilmentKind: "DELIVERY" } as never;

function keysFor(
  netted: Array<{ productId: string; qtyDelta: number }>,
  items: Array<{ id?: string | null; productId?: string | null }>,
) {
  const params = iGate.edit("t1", "c1", netted, items, [], undefined, undefined, sale);
  return params.lines.map((l) => l.lineKey);
}

describe("iGate.edit line keys (W-748 Q2, SA-1017)", () => {
  it("a kept line plus an added line of the same product keys on the ADDED line", () => {
    expect(
      keysFor(
        [{ productId: "p-held", qtyDelta: 1 }],
        [
          { id: "line-1", productId: "p-held" },
          { productId: "p-held" },
        ],
      ),
    ).toEqual(["n:1"]);
  });

  it("an added line listed BEFORE the kept line still wins (first entry with no id)", () => {
    expect(
      keysFor(
        [{ productId: "p-held", qtyDelta: 1 }],
        [{ productId: "p-held" }, { id: "line-1", productId: "p-held" }],
      ),
    ).toEqual(["n:0"]);
  });

  it("a raise on a kept line alone keeps today's key, l:<id>", () => {
    expect(
      keysFor([{ productId: "p-held", qtyDelta: 7 }], [{ id: "line-1", productId: "p-held" }]),
    ).toEqual(["l:line-1"]);
  });

  it("a new product keys on its own index, and each product keys independently", () => {
    expect(
      keysFor(
        [
          { productId: "p-held", qtyDelta: 1 },
          { productId: "p-new", qtyDelta: 1 },
        ],
        [
          { id: "line-1", productId: "p-held" },
          { productId: "p-held" },
          { productId: "p-new" },
        ],
      ),
    ).toEqual(["n:1", "n:2"]);
  });
});
