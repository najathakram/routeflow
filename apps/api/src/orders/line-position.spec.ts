import {
  compareOrderLines,
  densifyOrderLines,
  linePositionAllocator,
  lineRanks,
  loserLineRanks,
  replaceSlotPlanner,
  sortOrderLines,
} from "./line-position";

/** W-1187 (D3/D4): the pure ranking helpers every line writer shares. */
const t = (n: number) => new Date(Date.UTC(2026, 10, 1, 12, n));

describe("compareOrderLines / sortOrderLines (the read order in memory)", () => {
  it("position ascending, a NULL position last", () => {
    const lines = [
      { id: "c", position: null, createdAt: t(0) },
      { id: "b", position: 1, createdAt: t(0) },
      { id: "a", position: 0, createdAt: t(0) },
    ];
    expect(sortOrderLines(lines).map((l) => l.id)).toEqual(["a", "b", "c"]);
  });

  it("ties on position fall to createdAt, then id", () => {
    const lines = [
      { id: "z", position: 2, createdAt: t(1) },
      { id: "b", position: 2, createdAt: t(2) },
      { id: "y", position: 2, createdAt: t(1) },
    ];
    expect(sortOrderLines(lines).map((l) => l.id)).toEqual(["y", "z", "b"]);
  });

  it("does not mutate its input and agrees with compareOrderLines", () => {
    const lines = [
      { id: "b", position: 1 },
      { id: "a", position: 0 },
    ];
    const copy = [...lines];
    sortOrderLines(lines);
    expect(lines).toEqual(copy);
    expect(compareOrderLines(lines[0], lines[1])).toBeGreaterThan(0);
  });

  it("lineRanks maps each id to its place in the read order, NULL positions included", () => {
    const ranks = lineRanks([
      { id: "n", position: null, createdAt: t(0) },
      { id: "x", position: 4, createdAt: t(9) },
      { id: "y", position: 1, createdAt: t(0) },
    ]);
    expect([ranks.get("y"), ranks.get("x"), ranks.get("n")]).toEqual([0, 1, 2]);
  });
});

describe("loserLineRanks (D4: carts in the order they were started)", () => {
  it("ranks the older cart's lines first whatever the array order, each cart in its own read order", () => {
    const ranks = loserLineRanks([
      {
        id: "late",
        createdAt: t(20),
        lineItems: [
          { id: "late-b", position: 1 },
          { id: "late-a", position: 0 },
        ],
      },
      { id: "early", createdAt: t(5), lineItems: [{ id: "early-a", position: 0 }] },
    ]);
    expect(["early-a", "late-a", "late-b"].map((id) => ranks.get(id))).toEqual([0, 1, 2]);
  });

  it("breaks a createdAt tie by order id and ranks unpositioned lines last inside their cart", () => {
    const same = t(3);
    const ranks = loserLineRanks([
      { id: "o2", createdAt: same, lineItems: [{ id: "o2-1", position: null, createdAt: same }] },
      {
        id: "o1",
        createdAt: same,
        lineItems: [
          { id: "o1-n", position: null, createdAt: same },
          { id: "o1-0", position: 0, createdAt: same },
        ],
      },
    ]);
    expect(["o1-0", "o1-n", "o2-1"].map((id) => ranks.get(id))).toEqual([0, 1, 2]);
  });
});

describe("replaceSlotPlanner (a replace edit keeps each surviving line in its slot)", () => {
  const stored = [
    { id: "s0", position: 0, productId: "pa", name: null },
    { id: "s1", position: 1, productId: null, name: "Loose" },
    { id: "s2", position: 2, productId: "pb", name: null },
  ];

  it("a paired entry takes its source line's slot, whatever its place in the payload", () => {
    const plan = replaceSlotPlanner(stored);
    expect(plan.slotFor({ sourceLineId: "s2", productId: "pb" })).toBe(2);
    expect(plan.slotFor({ sourceLineId: "s0", productId: "pa" })).toBe(0);
  });

  it("an unlisted entry takes the stored unlisted line of the same name; a new entry goes last", () => {
    const plan = replaceSlotPlanner(stored);
    expect(plan.slotFor({ productId: null, name: " Loose " })).toBe(1);
    expect(plan.slotFor({ productId: "pnew" })).toBe(3);
    expect(plan.slotFor({ productId: "pnew2" })).toBe(4);
  });

  it("a slot is handed out once: a second entry for the same source line appends", () => {
    const plan = replaceSlotPlanner(stored);
    expect(plan.slotFor({ sourceLineId: "s0", productId: "pa" })).toBe(0);
    expect(plan.slotFor({ sourceLineId: "s0", productId: "pa" })).toBe(3);
  });

  it("an unknown source id appends; slotOf answers undefined for it", () => {
    const plan = replaceSlotPlanner(stored);
    expect(plan.slotOf("nope")).toBeUndefined();
    expect(plan.slotOf("s1")).toBe(1);
    expect(plan.slotFor({ sourceLineId: "nope", productId: "pa" })).toBe(3);
  });

  it("legacy NULL positions rank by the read order, so nothing moves", () => {
    const plan = replaceSlotPlanner([
      { id: "b", position: null, productId: "pb", createdAt: t(2) },
      { id: "a", position: null, productId: "pa", createdAt: t(1) },
    ]);
    expect(plan.slotOf("a")).toBe(0);
    expect(plan.slotOf("b")).toBe(1);
  });
});

/** A fake transaction over an in-memory OrderItem table, to count the writes. */
function fakeTx(rows: Array<{ id: string; position: number | null; createdAt?: Date }>) {
  const updates: Array<{ id: string; position: number }> = [];
  const tx = {
    orderItem: {
      findMany: jest.fn(async () => sortOrderLines(rows).map((r) => ({ ...r }))),
      update: jest.fn(async ({ where, data }: any) => {
        updates.push({ id: where.id, position: data.position });
        const row = rows.find((r) => r.id === where.id)!;
        row.position = data.position;
      }),
    },
  };
  return { tx: tx as any, updates };
}

describe("densifyOrderLines", () => {
  it("fills NULLs and breaks duplicate positions into 0..n-1 without reordering", async () => {
    const { tx, updates } = fakeTx([
      { id: "a", position: 3, createdAt: t(1) },
      { id: "b", position: null, createdAt: t(1) },
      { id: "c", position: 3, createdAt: t(2) },
    ]);
    expect(await densifyOrderLines(tx, "o1")).toBe(3);
    expect(updates).toEqual([
      { id: "a", position: 0 },
      { id: "c", position: 1 },
      { id: "b", position: 2 },
    ]);
  });

  it("writes nothing when the positions are already dense", async () => {
    const { tx, updates } = fakeTx([
      { id: "a", position: 0 },
      { id: "b", position: 1 },
    ]);
    expect(await densifyOrderLines(tx, "o1")).toBe(2);
    expect(updates).toEqual([]);
  });
});

describe("linePositionAllocator", () => {
  it("is lazy: no query until the first next()", async () => {
    const { tx } = fakeTx([{ id: "a", position: 0 }]);
    linePositionAllocator(tx, "o1");
    expect(tx.orderItem.findMany).not.toHaveBeenCalled();
  });

  it("densifies once, then hands out n, n+1, ...", async () => {
    const { tx, updates } = fakeTx([
      { id: "a", position: null },
      { id: "b", position: 7 },
    ]);
    const slots = linePositionAllocator(tx, "o1");
    expect([await slots.next(), await slots.next(), await slots.next()]).toEqual([2, 3, 4]);
    expect(tx.orderItem.findMany).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(2);
  });

  it("an empty order starts at 0", async () => {
    const { tx } = fakeTx([]);
    expect(await linePositionAllocator(tx, "o1").next()).toBe(0);
  });
});
