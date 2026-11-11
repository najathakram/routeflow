import {
  buildMergeLineWrites,
  orderMergeAppends,
  type MergeLine,
  type MergeLineWrite,
} from "./merge-line-writes";
import type { UnlistedMergeItem } from "./merge-unlisted-lines";

/**
 * W-1187 (D4): a merge appends the losers' lines after the winner's in the order the carts were laid out. The pure half:
 * every create carries the `appendRank` of the loser line(s) it came from, and `orderMergeAppends` interleaves catalog
 * creates and unlisted lines by it.
 */
const line = (
  id: string | undefined,
  productId: string,
  o: Partial<Record<string, unknown>> = {},
) =>
  ({
    id,
    productId,
    qty: 1,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 2,
    subtotal: 2,
    priceType: "STANDARD",
    originalPrice: null,
    overrideReason: null,
    overriddenBy: null,
    notes: null,
    promoFreeUnits: null,
    trackedCategoryId: null,
    categoryTaxType: null,
    categoryTaxRate: null,
    categoryPriceIncludesTax: null,
    ...o,
  }) as unknown as MergeLine;

const opts = {
  promos: [],
  canEarnNew: false,
  categoryFor: () => null,
  liveUnitsPerBoxFor: () => 1,
};

const creates = (writes: MergeLineWrite[]) =>
  writes.flatMap((w) => (w.kind === "create" ? [w.data] : []));

describe("buildMergeLineWrites carries appendRank on every create", () => {
  it("a loser-only product's create takes the rank of its line", () => {
    const { writes } = buildMergeLineWrites(
      [line("w1", "pw")],
      [line("l1", "pa", { appendRank: 5 }), line("l2", "pb", { appendRank: 2 })],
      opts,
    );
    const byProduct = Object.fromEntries(creates(writes).map((c) => [c.productId, c.appendRank]));
    expect(byProduct).toEqual({ pa: 5, pb: 2 });
  });

  it("lines of one loser-only product folded into one create take the earliest rank", () => {
    const { writes } = buildMergeLineWrites(
      [line("w1", "pw")],
      [line("l1", "pa", { appendRank: 7 }), line("l2", "pa", { appendRank: 4 })],
      opts,
    );
    expect(creates(writes)).toHaveLength(1);
    expect(creates(writes)[0].appendRank).toBe(4);
  });

  it("an unranked loser line sorts after every ranked one", () => {
    const { writes } = buildMergeLineWrites(
      [line("w1", "pw")],
      [line("l1", "pa"), line("l2", "pb", { appendRank: 9 })],
      opts,
    );
    const [pa, pb] = ["pa", "pb"].map((p) => creates(writes).find((c) => c.productId === p)!);
    expect(pb.appendRank).toBeLessThan(pa.appendRank);
  });

  it("a same-product fold updates the winner's line and creates nothing", () => {
    const { writes } = buildMergeLineWrites(
      [line("w1", "pa")],
      [line("l1", "pa", { appendRank: 3 })],
      opts,
    );
    expect(creates(writes)).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: "update", lineId: "w1" });
  });
});

describe("orderMergeAppends", () => {
  const unlisted = (name: string, appendRank: number) =>
    ({ name, appendRank }) as unknown as UnlistedMergeItem;
  const create = (productId: string, appendRank: number): MergeLineWrite =>
    ({ kind: "create", data: { productId, appendRank } }) as unknown as MergeLineWrite;

  it("interleaves catalog creates and unlisted lines by rank", () => {
    const out = orderMergeAppends(
      [
        create("pa", 3),
        { kind: "update", lineId: "w1", data: {} } as MergeLineWrite,
        create("pb", 0),
      ],
      [unlisted("Loose", 1), unlisted("Other", 4)],
    );
    expect(
      out.map((a) =>
        a.kind === "catalog" ? a.data.productId : (a.data as UnlistedMergeItem).name,
      ),
    ).toEqual(["pb", "Loose", "pa", "Other"]);
  });

  it("is stable on equal ranks: catalog first, then unlisted, each in production order", () => {
    const out = orderMergeAppends(
      [create("p1", 0), create("p2", 0)],
      [unlisted("u1", 0), unlisted("u2", 0)],
    );
    expect(out.map((a) => a.kind)).toEqual(["catalog", "catalog", "unlisted", "unlisted"]);
    expect(
      out.map(
        (a) =>
          (a.data as { productId?: string; name?: string }).productId ??
          (a.data as UnlistedMergeItem).name,
      ),
    ).toEqual(["p1", "p2", "u1", "u2"]);
  });

  it("skips update writes and answers empty for nothing to append", () => {
    expect(
      orderMergeAppends([{ kind: "update", lineId: "w", data: {} } as MergeLineWrite], []),
    ).toEqual([]);
  });
});
