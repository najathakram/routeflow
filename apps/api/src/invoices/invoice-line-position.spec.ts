import {
  invoiceLinesInOrder,
  legacyOrderKept,
  orderLineRanks,
  rankInvoiceLines,
  stampInvoicePositions,
} from "./invoice-line-position";

/**
 * W-1187 (D1, D6): an invoice line's `position` is the slot the staff gave its order line, so a printed bill follows the
 * order. One helper ranks every writer's lines; one helper picks the shown order. A line with no position anywhere keeps
 * the SA-1058 A-Z order for good (owner Q2: old invoices print as they did).
 */
const line = (id: string, orderItemId: string | null, description = id) => ({
  id,
  orderItemId,
  description,
  productId: orderItemId ? "p" : null,
});

describe("rankInvoiceLines", () => {
  it("a standalone invoice (no order ranks) ranks its lines by payload index, dense 0..n-1", () => {
    expect(rankInvoiceLines([line("a", null), line("b", null), line("c", null)])).toEqual([
      0, 1, 2,
    ]);
  });

  it("order-linked lines take the order line's rank, whatever the array order (R12: source order, not request order)", () => {
    const ranks = orderLineRanks([
      { id: "o-zebra", position: 0 },
      { id: "o-apple", position: 1 },
    ]);
    // the request lists Apple first; the order built Zebra first
    expect(rankInvoiceLines([line("i1", "o-apple"), line("i2", "o-zebra")], ranks)).toEqual([1, 0]);
  });

  it("unlinked lines (a manual line, the NSF fee) come after every linked line, in their own order", () => {
    const ranks = orderLineRanks([
      { id: "o1", position: 0 },
      { id: "o2", position: 1 },
    ]);
    const lines = [line("m", null), line("i2", "o2"), line("nsf", null), line("i1", "o1")];
    expect(rankInvoiceLines(lines, ranks)).toEqual([2, 1, 3, 0]);
  });

  it("a linked line whose order line is not ranked (cancelled, gone) is treated as unlinked, never dropped or NaN", () => {
    const ranks = orderLineRanks([{ id: "o1", position: 0 }]);
    expect(rankInvoiceLines([line("x", "o-missing"), line("i1", "o1")], ranks)).toEqual([1, 0]);
  });

  it("is dense and unique for any shuffle (property)", () => {
    const ranks = orderLineRanks(
      Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, position: i })),
    );
    for (let seed = 1; seed <= 25; seed++) {
      const order = Array.from({ length: 8 }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = (seed * 7 + i * 13) % (i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
      const lines = [...order.map((i) => line(`i${i}`, `o${i}`)), line("m", null)];
      const out = rankInvoiceLines(lines, ranks);
      expect([...out].sort((a, b) => a - b)).toEqual(Array.from({ length: 9 }, (_, i) => i));
      order.forEach((o, idx) => expect(out[idx]).toBe(o)); // linked line i-o holds the order's rank o
      expect(out[8]).toBe(8); // manual last
    }
  });
});

describe("stampInvoicePositions", () => {
  it("writes `position` onto the SAME data objects and returns the array (no copy: writers keep their references)", () => {
    const data = [line("a", null), line("b", null)] as Array<Record<string, unknown>>;
    const out = stampInvoicePositions(data);
    expect(out).toBe(data);
    expect(data.map((d) => d.position)).toEqual([0, 1]);
  });

  it("ranks a linked draft's lines by their order, and the rest after", () => {
    const ranks = orderLineRanks([
      { id: "o-b", position: 0 },
      { id: "o-a", position: 1 },
    ]);
    const data = [line("ia", "o-a"), line("ib", "o-b")] as Array<Record<string, unknown>>;
    stampInvoicePositions(data, ranks);
    expect(data.map((d) => d.position)).toEqual([1, 0]);
  });
});

describe("invoiceLinesInOrder", () => {
  const row = (
    id: string,
    description: string,
    position: number | null,
    createdAt = "2026-01-01",
  ) => ({
    id,
    description,
    position,
    createdAt: new Date(createdAt),
    productId: "p",
  });

  it("R10: every line carries a position, so the order the staff built wins over A-Z", () => {
    const items = [row("1", "Apple", 1), row("2", "Zebra", 0)];
    expect(invoiceLinesInOrder(items).map((l) => l.description)).toEqual(["Zebra", "Apple"]);
  });

  it("G-c: one NULL position and the whole invoice keeps the permanent SA-1058 A-Z order", () => {
    const items = [row("1", "Zebra", 0), row("2", "Apple", null), row("3", "Mango", 1)];
    expect(invoiceLinesInOrder(items).map((l) => l.description)).toEqual([
      "Apple",
      "Mango",
      "Zebra",
    ]);
  });

  it("an invoice with no positions at all prints A-Z, exactly as before this change", () => {
    const items = [row("1", "Zebra", null), row("2", "Apple", null)];
    expect(invoiceLinesInOrder(items).map((l) => l.description)).toEqual(["Apple", "Zebra"]);
  });

  it("ties on position break on createdAt then id, so two reads never differ", () => {
    const items = [
      row("b", "x", 0, "2026-01-02"),
      row("c", "x", 0, "2026-01-01"),
      row("a", "x", 0, "2026-01-01"),
    ];
    expect(invoiceLinesInOrder(items).map((l) => l.id)).toEqual(["a", "c", "b"]);
  });

  it("returns a NEW array (SA-874: the hashed snapshot is never sorted in place)", () => {
    const items = [row("1", "Apple", 1), row("2", "Zebra", 0)];
    const before = items.map((i) => i.id);
    const out = invoiceLinesInOrder(items);
    expect(out).not.toBe(items);
    expect(items.map((i) => i.id)).toEqual(before);
  });

  it("an empty list is an empty list", () => {
    expect(invoiceLinesInOrder([])).toEqual([]);
  });
});

describe("legacyOrderKept", () => {
  const row = (id: string, description: string, position: number | null) => ({
    id,
    description,
    position,
    createdAt: new Date("2026-01-01"),
    productId: "p",
  });
  const legacy = [row("z", "Zebra", null), row("a", "Apple", null), row("m", "Mango", null)];

  it("a legacy invoice saved in its shown (A-Z) order writes no position", () => {
    expect(legacyOrderKept(legacy, ["a", "m", "z"])).toBe(true);
  });

  it("a legacy invoice with a line dropped, the rest in shown order, still writes none", () => {
    expect(legacyOrderKept(legacy, ["a", "z"])).toBe(true);
  });

  it("a legacy invoice with a new line added at the end (the rest in shown order) writes none", () => {
    expect(legacyOrderKept(legacy, ["a", "m", "z", null])).toBe(true);
  });

  it("a legacy invoice whose lines are reordered by the save is stamped", () => {
    expect(legacyOrderKept(legacy, ["z", "a", "m"])).toBe(false);
  });

  it("a fully positioned invoice is always stamped", () => {
    const positioned = [row("z", "Zebra", 0), row("a", "Apple", 1)];
    expect(legacyOrderKept(positioned, ["z", "a"])).toBe(false);
  });

  it("a half-positioned invoice (the NSF fee on a legacy one) counts as legacy", () => {
    const half = [row("z", "Zebra", null), row("a", "Apple", 0)];
    expect(legacyOrderKept(half, ["a", "z"])).toBe(true); // shown A-Z: Apple, Zebra
  });
});
