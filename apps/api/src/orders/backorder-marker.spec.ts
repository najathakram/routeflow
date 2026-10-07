import { editMarkers, saleMarkers } from "./backorder-marker";

/** SA-714 R1 / SA-716: pure attribution of the per-line backorder marker (PIECES). */
const line = (productId: string, qty: number, position: number | null, extra: object = {}) => ({
  productId,
  qty,
  position,
  ...extra,
});
const sale = (
  lines: ReturnType<typeof line>[],
  available: number,
  opts: { allow?: boolean; pack?: number | null } = {},
) =>
  saleMarkers({
    lines,
    packByProduct: new Map([["p", opts.pack ?? null]]),
    availableByProduct: new Map([["p", available]]),
    allowOversell: opts.allow ?? true,
  });

describe("saleMarkers (SET at a fresh sale moment)", () => {
  it("fills lines by position asc; the remainder lands on the LATER lines", () => {
    const a = line("p", 6, 0);
    const b = line("p", 6, 1);
    const m = sale([a, b], 10);
    expect(m.get(a)).toBe(0);
    expect(m.get(b)).toBe(2);
  });

  it("is independent of array order (position decides, not index)", () => {
    const a = line("p", 6, 0);
    const b = line("p", 6, 1);
    const m = sale([b, a], 10);
    expect(m.get(a)).toBe(0);
    expect(m.get(b)).toBe(2);
  });

  it("splits one product across three lines (stock 4, lines 3/3/3 -> 0/2/3)", () => {
    const [a, b, c] = [line("p", 3, 0), line("p", 3, 1), line("p", 3, 2)];
    const m = sale([a, b, c], 4);
    expect([m.get(a), m.get(b), m.get(c)]).toEqual([0, 2, 3]);
  });

  it("null positions sort LAST; ties fall back to input order", () => {
    const a = line("p", 5, null);
    const b = line("p", 5, 0);
    const c = line("p", 5, null);
    const m = sale([a, b, c], 5);
    expect([m.get(b), m.get(a), m.get(c)]).toEqual([0, 5, 5]);
  });

  it("is per product: another product's stock never fills this one", () => {
    const a = line("p", 4, 0);
    const b = line("q", 4, 1);
    const m = saleMarkers({
      lines: [a, b],
      packByProduct: new Map(),
      availableByProduct: new Map([
        ["p", 100],
        ["q", 0],
      ]),
      allowOversell: true,
    });
    expect([m.get(a), m.get(b)]).toEqual([0, 4]);
  });

  it("counts PIECES, never boxes (2 boxes of a 12-pack = 24)", () => {
    const a = line("p", 2, 0); // box-unaware boxed line: qty is BOXES, the live pack sizes it
    expect(sale([a], 10, { pack: 12 }).get(a)).toBe(14);
  });

  it("negative or zero stock backorders the whole line", () => {
    const a = line("p", 5, 0);
    expect(sale([a], -3).get(a)).toBe(5);
    expect(sale([a], 0).get(a)).toBe(5);
  });

  it("allowOversell=false marks nothing", () => {
    const a = line("p", 5, 0);
    expect(sale([a], 0, { allow: false }).get(a)).toBe(0);
  });

  it("a negative line never throws and never marks (informational field, never fails a sale)", () => {
    const a = line("p", -2, 0);
    const b = line("p", 5, 1);
    const m = sale([a, b], 0);
    expect(m.get(a)).toBe(0);
    expect(m.get(b)).toBe(0);
  });

  it("sums to the pure helper's per-product total", () => {
    const ls = [line("p", 2.5, 0), line("p", 3.25, 1), line("p", 1, 2)];
    const m = sale(ls, 4);
    const total = [...m.values()].reduce((s, n) => s + n, 0);
    expect(Math.round(total * 1000) / 1000).toBe(2.75);
  });
});

describe("editMarkers (ADJUST on edit; SET for a re-decrement)", () => {
  const L = (id: string, position: number | null, marker: number, held: number, final: number) => ({
    id,
    position,
    marker,
    held,
    final,
  });

  it("an increase adds its backorder delta to THAT line", () => {
    const out = editMarkers({ lines: [L("a", 0, 0, 5, 10)], backorder: 3, mode: "adjust" });
    expect(out.get("a")).toBe(3);
  });

  it("adds onto an existing marker", () => {
    const out = editMarkers({ lines: [L("a", 0, 2, 5, 10)], backorder: 3, mode: "adjust" });
    expect(out.get("a")).toBe(5);
  });

  it("a reduction releases backordered pieces first: max(0, marker - reduced)", () => {
    expect(
      editMarkers({ lines: [L("a", 0, 6, 10, 6)], backorder: 0, mode: "adjust" }).get("a"),
    ).toBe(2);
    expect(
      editMarkers({ lines: [L("a", 0, 6, 10, 1)], backorder: 0, mode: "adjust" }).get("a"),
    ).toBe(0);
  });

  it("a reduction on an unmarked line writes nothing", () => {
    const out = editMarkers({ lines: [L("a", 0, 0, 10, 4)], backorder: 0, mode: "adjust" });
    expect(out.size).toBe(0);
  });

  it("two increased lines of one product: later position takes the remainder, each capped by its own increase", () => {
    const out = editMarkers({
      lines: [L("a", 0, 0, 0, 4), L("b", 1, 0, 0, 4)],
      backorder: 6,
      mode: "adjust",
    });
    expect(out.get("b")).toBe(4);
    expect(out.get("a")).toBe(2);
  });

  it("a net-zero mix: the increased line takes the delta, the reduced line releases", () => {
    const out = editMarkers({
      lines: [L("a", 0, 0, 5, 10), L("b", 1, 4, 8, 5)],
      backorder: 2,
      mode: "adjust",
    });
    expect(out.get("a")).toBe(2);
    expect(out.get("b")).toBe(1);
  });

  it("a NEW line (held 0) takes the backorder like an increase", () => {
    const out = editMarkers({ lines: [L("n", 3, 0, 0, 7)], backorder: 7, mode: "adjust" });
    expect(out.get("n")).toBe(7);
  });

  it("an untouched line is left alone", () => {
    const out = editMarkers({
      lines: [L("a", 0, 4, 5, 5), L("b", 1, 0, 5, 9)],
      backorder: 1,
      mode: "adjust",
    });
    expect(out.has("a")).toBe(false);
    expect(out.get("b")).toBe(1);
  });

  it("set mode ignores the old marker: only this re-decrement's own value (reopen)", () => {
    const out = editMarkers({
      lines: [L("a", 0, 8, 0, 6), L("b", 1, 5, 0, 6)],
      backorder: 4,
      mode: "set",
    });
    expect(out.get("a")).toBe(0);
    expect(out.get("b")).toBe(4);
  });

  it("set mode zeroes a stale marker when nothing is backordered now", () => {
    const out = editMarkers({ lines: [L("a", 0, 8, 0, 6)], backorder: 0, mode: "set" });
    expect(out.get("a")).toBe(0);
  });
});
