import { attributeBackorderToLines } from "./oversell-policy";

/**
 * SA-606k (lines): the per-product overshoot from the locked write is attributed to that product's
 * lines in REQUEST order, stock-first — earlier lines take the covered pieces, later lines carry the
 * shortfall — so the sum over a product's lines equals the product's overshoot (the movement's).
 */
const l = (productId: string | null, pieces: number) => ({ productId, pieces });

describe("attributeBackorderToLines", () => {
  it("stock 10, lines [6,6,3] (sum 15, overshoot 5) -> [0,2,3]", () => {
    expect(
      attributeBackorderToLines([l("p", 6), l("p", 6), l("p", 3)], new Map([["p", 5]])),
    ).toEqual([0, 2, 3]);
  });

  it("everything backordered (stock already negative) -> every line carries its own pieces", () => {
    expect(attributeBackorderToLines([l("p", 4), l("p", 2)], new Map([["p", 6]]))).toEqual([4, 2]);
  });

  it("nothing backordered -> all zero, one entry per input line", () => {
    expect(attributeBackorderToLines([l("a", 3), l("b", 1)], new Map())).toEqual([0, 0]);
  });

  it("same product on non-adjacent lines; products independent", () => {
    const lines = [l("a", 3), l("b", 5), l("a", 3)];
    expect(
      attributeBackorderToLines(
        lines,
        new Map([
          ["a", 4],
          ["b", 0],
        ]),
      ),
    ).toEqual([1, 0, 3]);
  });

  it("a line with no product (unlisted) never touches stock -> 0", () => {
    expect(attributeBackorderToLines([l(null, 7), l("p", 2)], new Map([["p", 2]]))).toEqual([0, 2]);
  });

  it("property: per product, sum(lines) === overshoot, each line within [0, its pieces]", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = (n: number) => ((seed * 9301 + n * 49297) % 233280) / 233280;
      const lines = Array.from({ length: 1 + (seed % 5) }, (_, i) =>
        l(i % 2 ? "a" : "b", Math.round(r(i + 1) * 12 * 1000) / 1000),
      );
      const sum = (id: string) =>
        lines.filter((x) => x.productId === id).reduce((s, x) => s + x.pieces, 0);
      const over = new Map<string, number>(
        ["a", "b"].map((id) => [id, Math.round(Math.min(sum(id), r(9) * 10) * 1000) / 1000]),
      );
      const out = attributeBackorderToLines(lines, over);
      expect(out).toHaveLength(lines.length);
      out.forEach((v, i) => {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(lines[i].pieces + 1e-9);
      });
      for (const id of ["a", "b"]) {
        const got = lines.reduce((s, x, i) => s + (x.productId === id ? out[i] : 0), 0);
        expect(Math.round(got * 1000) / 1000).toBe(over.get(id));
      }
    }
  });
});
