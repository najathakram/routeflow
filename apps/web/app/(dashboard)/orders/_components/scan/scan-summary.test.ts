import { computeLineSubtotal } from "@routeflow/pricing";
import {
  SCAN_HISTORY_LIMIT,
  distinctSkuCount,
  popHistory,
  pushHistory,
  scanTotal,
  type SummaryLine,
} from "./scan-summary";

const line = (o: Partial<SummaryLine> = {}): SummaryLine => ({
  productId: "p1",
  unitPrice: 2.5,
  qty: 1,
  ...o,
});

describe("distinctSkuCount (owner ruling D2: SKUs, not units)", () => {
  it("counts each product once however many units are on it", () => {
    expect(
      distinctSkuCount([line({ productId: "a", qty: 12 }), line({ productId: "b", qty: 1 })]),
    ).toBe(2);
  });

  it("a repeated productId collapses to one SKU", () => {
    expect(distinctSkuCount([line({ productId: "a" }), line({ productId: "a" })])).toBe(1);
  });

  it("every unlisted (free-text) line is its own item — it has no SKU to collapse on", () => {
    expect(
      distinctSkuCount([
        line({ productId: "", isUnlisted: true }),
        line({ productId: "", isUnlisted: true }),
        line({ productId: "a" }),
      ]),
    ).toBe(3);
  });

  it("is 0 for an empty order", () => {
    expect(distinctSkuCount([])).toBe(0);
  });
});

describe("scanTotal", () => {
  it("prices a plain line as qty x unitPrice, rounded to cents", () => {
    expect(scanTotal([line({ unitPrice: 8.99, qty: 3 })])).toBe(26.97);
  });

  it("uses boxed proration, never qty * unitPrice (over-charges by unitsPerBox)", () => {
    const boxed = line({ unitPrice: 24, qty: 7, boxes: 1, pieces: 1, unitsPerBox: 6 });
    const expected = computeLineSubtotal({
      unitPrice: 24,
      qty: 7,
      boxes: 1,
      pieces: 1,
      unitsPerBox: 6,
    });
    expect(scanTotal([boxed])).toBe(expected);
    expect(scanTotal([boxed])).not.toBe(24 * 7);
  });

  it("sums lines and rounds the SUM once (0.1 + 0.2 style float drift never shows)", () => {
    expect(scanTotal([line({ unitPrice: 0.1 }), line({ productId: "b", unitPrice: 0.2 })])).toBe(
      0.3,
    );
  });

  it("is 0 for an empty order", () => {
    expect(scanTotal([])).toBe(0);
  });
});

describe("scan history", () => {
  it("pops the most recent entry LIFO and returns the rest", () => {
    const h1 = pushHistory([], { productId: "a", created: true });
    const h2 = pushHistory(h1, { productId: "a", created: false });
    const { entry, rest } = popHistory(h2);
    expect(entry).toEqual({ productId: "a", created: false });
    expect(rest).toEqual(h1);
  });

  it("popping an empty stack yields no entry", () => {
    expect(popHistory([])).toEqual({ entry: null, rest: [] });
  });

  it(`is bounded at ${SCAN_HISTORY_LIMIT}, dropping the OLDEST`, () => {
    let h: ReturnType<typeof pushHistory> = [];
    for (let i = 0; i < SCAN_HISTORY_LIMIT + 5; i++)
      h = pushHistory(h, { productId: `p${i}`, created: true });
    expect(h).toHaveLength(SCAN_HISTORY_LIMIT);
    expect(h[0].productId).toBe("p5");
    expect(h[h.length - 1].productId).toBe(`p${SCAN_HISTORY_LIMIT + 4}`);
  });

  it("never mutates its input", () => {
    const h = Object.freeze([{ productId: "a", created: true }]) as never;
    expect(() => pushHistory(h, { productId: "b", created: true })).not.toThrow();
    expect(() => popHistory(h)).not.toThrow();
  });
});
