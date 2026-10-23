import { act, renderHook } from "@testing-library/react";
import { computeLineSubtotal } from "@routeflow/pricing";
import { useBuyerCart, type CartItem } from "./buyer-cart";

/**
 * Row 531 (P0): typing 2 on a 12/box line changed ONLY `qty`, leaving the stale `boxes: 1`, and
 * the cart priced the split while the row showed the qty. Every mutation must leave a boxed line
 * with `qty === boxes * unitsPerBox + pieces`, and the stepper counts the line's SELLING UNIT.
 */

const KEY = "buyerCart_b1_acme";
const UPB = 12;
const BOX_PRICE = 15.6;

const caseLine = (over: Partial<CartItem> = {}): CartItem => ({
  productId: "p1",
  name: "Widget",
  unit: "each",
  unitsPerBox: UPB,
  qty: UPB,
  boxes: 1,
  pieces: 0,
  ...over,
});

function setup() {
  return renderHook(() => useBuyerCart("b1", "acme"));
}

function stored(): { items: CartItem[] } {
  return JSON.parse(localStorage.getItem(KEY) ?? '{"items":[]}');
}

function price(i: CartItem): number {
  return computeLineSubtotal({
    unitPrice: BOX_PRICE,
    qty: i.qty,
    boxes: i.boxes ?? null,
    pieces: i.pieces ?? null,
    unitsPerBox: i.unitsPerBox ?? null,
  });
}

function expectInvariant(i: CartItem) {
  expect(i.qty).toBe((i.boxes ?? 0) * UPB + (i.pieces ?? 0));
}

beforeEach(() => localStorage.clear());

describe("buyer cart: a boxed line keeps qty and its box split in step", () => {
  it("typing 2 on a Case line means 2 Cases: qty 24, boxes 2, pieces 0, priced as 2 Cases", () => {
    const { result } = setup();
    act(() => result.current.addItem(caseLine()));
    act(() => result.current.updateQty("p1", 2));
    const i = result.current.items[0];
    expect(i).toMatchObject({ qty: 24, boxes: 2, pieces: 0 });
    expect(price(i)).toBe(31.2);
  });

  it.each([1, 2, 5, 11, 12, 13, 24, 25])("updateQty(%i) leaves qty === boxes*upb + pieces", (n) => {
    const { result } = setup();
    act(() => result.current.addItem(caseLine()));
    act(() => result.current.updateQty("p1", n));
    const i = result.current.items[0];
    expectInvariant(i);
    expect(i.qty).toBe(n * UPB);
    expect(stored().items[0]).toMatchObject({ qty: n * UPB, boxes: n, pieces: 0 });
  });

  it("the stepper's + and - walk whole Cases (24 -> 36 -> 24), never a stale split", () => {
    const { result } = setup();
    act(() => result.current.addItem(caseLine({ qty: 24, boxes: 2 })));
    act(() => result.current.updateQty("p1", 3));
    expect(result.current.items[0]).toMatchObject({ qty: 36, boxes: 3, pieces: 0 });
    act(() => result.current.updateQty("p1", 2));
    expect(result.current.items[0]).toMatchObject({ qty: 24, boxes: 2, pieces: 0 });
  });

  it("switching to Each keeps the money, then 2 Each is qty 2 / boxes 0 / pieces 2", () => {
    const { result } = setup();
    act(() => result.current.addItem(caseLine()));
    const before = price(result.current.items[0]);
    act(() => result.current.setUnit("p1", "EACH"));
    expect(result.current.items[0]).toMatchObject({ qty: 12, boxes: 1, pieces: 0, sellBy: "EACH" });
    expect(price(result.current.items[0])).toBe(before);
    act(() => result.current.updateQty("p1", 2));
    const i = result.current.items[0];
    expect(i).toMatchObject({ qty: 2, boxes: 0, pieces: 2 });
    expect(price(i)).toBe(2.6); // 2 of 12 of the box price
  });

  it.each([0 + 1, 11, 12, 13, 24, 25])(
    "Each %i recomputes the split from the edited count",
    (n) => {
      const { result } = setup();
      act(() => result.current.addItem(caseLine()));
      act(() => result.current.setUnit("p1", "EACH"));
      act(() => result.current.updateQty("p1", n));
      const i = result.current.items[0];
      expectInvariant(i);
      expect(i).toMatchObject({ qty: n, boxes: Math.floor(n / UPB), pieces: n % UPB });
    },
  );

  it("a line with loose pieces cannot switch to Case (no silent rounding of money)", () => {
    const { result } = setup();
    act(() => result.current.addItem(caseLine()));
    act(() => result.current.setUnit("p1", "EACH"));
    act(() => result.current.updateQty("p1", 15));
    act(() => result.current.setUnit("p1", "CASE"));
    expect(result.current.items[0]).toMatchObject({ qty: 15, boxes: 1, pieces: 3, sellBy: "EACH" });
  });

  it("re-adding a line merges by whole Cases, never by adding a stale qty onto a stale split", () => {
    const { result } = setup();
    act(() => result.current.addItem(caseLine()));
    act(() => result.current.addItem(caseLine()));
    const i = result.current.items[0];
    expect(i).toMatchObject({ qty: 24, boxes: 2, pieces: 0 });
    expectInvariant(i);
  });

  it("no stale split survives any sequence of mutations", () => {
    const { result } = setup();
    act(() => result.current.addItem(caseLine()));
    const steps: Array<() => void> = [
      () => result.current.updateQty("p1", 3),
      () => result.current.setUnit("p1", "EACH"),
      () => result.current.updateQty("p1", 25),
      () => result.current.updateQty("p1", 7),
      () => result.current.addItem(caseLine()),
      () => result.current.setUnit("p1", "CASE"),
      () => result.current.updateQty("p1", 2),
      () => result.current.setUnit("p1", "EACH"),
    ];
    for (const step of steps) {
      act(step);
      expectInvariant(result.current.items[0]);
      expectInvariant(stored().items[0]);
    }
  });

  it("updateQty(0) removes the line; a plain product keeps qty alone", () => {
    const { result } = setup();
    act(() => result.current.addItem({ productId: "p2", qty: 1, name: "Loose", unit: "kg" }));
    act(() => result.current.updateQty("p2", 4));
    expect(result.current.items[0]).toMatchObject({ qty: 4 });
    expect(result.current.items[0].boxes).toBeUndefined();
    act(() => result.current.updateQty("p2", 0));
    expect(result.current.items).toHaveLength(0);
  });
});

describe("buyer cart: hydration re-derives a stored mismatched line from qty", () => {
  it("qty 2 / boxes 1 / pieces 0 (the P0 shape) reads back as 2 Each: boxes 0, pieces 2", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ items: [caseLine({ qty: 2, boxes: 1, pieces: 0 })] }),
    );
    const { result } = setup();
    expect(result.current.items[0]).toMatchObject({ qty: 2, boxes: 0, pieces: 2, sellBy: "EACH" });
    expect(price(result.current.items[0])).toBe(2.6);
  });

  it("the drifted cart stepper shape (qty 30, boxes 1, pieces 0) reads back from qty", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ items: [caseLine({ qty: 30, boxes: 1, pieces: 0 })] }),
    );
    const { result } = setup();
    expect(result.current.items[0]).toMatchObject({ qty: 30, boxes: 2, pieces: 6 });
    expectInvariant(result.current.items[0]);
  });

  it("a whole-Case mismatch (qty 24 / boxes 1) reads back as 2 Cases", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ items: [caseLine({ qty: 24, boxes: 1, pieces: 0 })] }),
    );
    const { result } = setup();
    expect(result.current.items[0]).toMatchObject({
      qty: 24,
      boxes: 2,
      pieces: 0,
      sellBy: "CASE",
    });
  });

  it("a consistent line is left exactly as stored", () => {
    localStorage.setItem(KEY, JSON.stringify({ items: [caseLine({ qty: 36, boxes: 3 })] }));
    const { result } = setup();
    expect(result.current.items[0]).toMatchObject({ qty: 36, boxes: 3, pieces: 0 });
  });
});

describe("R1: a stored pack size that differs from the catalog's is rebuilt (a repack)", () => {
  const packs = (n: number | null) => new Map([["p1", n]]);

  it("a Case line keeps its CASE COUNT: 2 Cases of 12 become 2 Cases of 6 (qty 12)", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ items: [caseLine({ qty: 24, boxes: 2, pieces: 0, sellBy: "CASE" })] }),
    );
    const { result } = setup();
    act(() => result.current.adoptCatalogPacks(packs(6)));
    expect(result.current.items[0]).toMatchObject({
      unitsPerBox: 6,
      qty: 12,
      boxes: 2,
      pieces: 0,
      sellBy: "CASE",
    });
    expect(stored().items[0]).toMatchObject({ unitsPerBox: 6, qty: 12, boxes: 2, pieces: 0 });
  });

  it("an Each line keeps its PIECES: 14 each of a 12-pack are 14 each of a 6-pack (2 boxes + 2)", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ items: [caseLine({ qty: 14, boxes: 1, pieces: 2, sellBy: "EACH" })] }),
    );
    const { result } = setup();
    act(() => result.current.adoptCatalogPacks(packs(6)));
    expect(result.current.items[0]).toMatchObject({
      unitsPerBox: 6,
      qty: 14,
      boxes: 2,
      pieces: 2,
      sellBy: "EACH",
    });
  });

  it("a repack is a correction the buyer is told about; an unchanged pack is not", () => {
    localStorage.setItem(KEY, JSON.stringify({ items: [caseLine()] }));
    const { result } = setup();
    act(() => result.current.adoptCatalogPacks(packs(12)));
    expect(result.current.items[0].corrected).toBeFalsy();
    act(() => result.current.adoptCatalogPacks(packs(6)));
    expect(result.current.items[0].corrected).toBe(true);
  });

  it("R1-b: a catalog row that is NOT boxed (pack null) rebuilds the line as a plain one: qty = pieces, split dropped, flagged", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ items: [caseLine({ qty: 24, boxes: 2, pieces: 0, sellBy: "CASE" })] }),
    );
    const { result } = setup();
    act(() => result.current.adoptCatalogPacks(packs(null)));
    const i = result.current.items[0];
    expect(i).toMatchObject({ qty: 24, corrected: true });
    expect(i.boxes).toBeUndefined();
    expect(i.pieces).toBeUndefined();
    expect(i.sellBy).toBeUndefined();
    expect(i.unitsPerBox).toBeNull();
    expect(stored().items[0]).toMatchObject({ qty: 24, corrected: true });
    expect(stored().items[0].boxes).toBeUndefined();
  });

  it("R1-b: a pack of 1 is not boxed either, and an Each line keeps its pieces", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ items: [caseLine({ qty: 14, boxes: 1, pieces: 2, sellBy: "EACH" })] }),
    );
    const { result } = setup();
    act(() => result.current.adoptCatalogPacks(packs(1)));
    expect(result.current.items[0]).toMatchObject({ qty: 14, corrected: true });
    expect(result.current.items[0].boxes).toBeUndefined();
  });

  it("NO catalog row at all (the product is absent from the map) leaves the line exactly as stored", () => {
    localStorage.setItem(KEY, JSON.stringify({ items: [caseLine()] }));
    const { result } = setup();
    act(() => result.current.adoptCatalogPacks(new Map()));
    expect(result.current.items[0]).toMatchObject({ unitsPerBox: 12, qty: 12, boxes: 1 });
    expect(result.current.items[0].corrected).toBeFalsy();
  });
});

describe("R2 + S8: hydration flags a contradicted line and writes the normalized line back", () => {
  it("flags ONLY the lines whose qty and split disagreed, and persists the repair", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        items: [
          caseLine({ productId: "a", qty: 2, boxes: 1, pieces: 0 }), // the P0 shape
          caseLine({ productId: "b", qty: 24, boxes: 2, pieces: 0 }), // consistent
          { productId: "c", name: "Loose", unit: "kg", qty: 3 }, // plain
        ],
      }),
    );
    const { result } = setup();
    const by = (id: string) => result.current.items.find((i) => i.productId === id)!;
    expect(by("a")).toMatchObject({ qty: 2, boxes: 0, pieces: 2, corrected: true });
    expect(by("b").corrected).toBeFalsy();
    expect(by("c").corrected).toBeFalsy();
    // written back: the stale boxes: 1 no longer sits in storage waiting for the next write
    const saved = stored().items.find((i) => i.productId === "a")!;
    expect(saved).toMatchObject({ qty: 2, boxes: 0, pieces: 2, corrected: true });
  });

  it("a SECOND mount still knows the line was corrected (the flag survives the write-back)", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ items: [caseLine({ qty: 2, boxes: 1, pieces: 0 })] }),
    );
    setup().unmount();
    const { result } = setup();
    expect(result.current.items[0]).toMatchObject({ qty: 2, boxes: 0, pieces: 2, corrected: true });
  });

  it("a consistent cart is not rewritten and nothing is flagged", () => {
    const raw = JSON.stringify({ items: [caseLine({ qty: 24, boxes: 2, sellBy: "CASE" })] });
    localStorage.setItem(KEY, raw);
    const { result } = setup();
    expect(result.current.items.some((i) => i.corrected)).toBe(false);
    expect(localStorage.getItem(KEY)).toBe(raw);
  });

  it("acknowledgeCorrections() clears every flag in state and in storage", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ items: [caseLine({ qty: 2, boxes: 1, pieces: 0 })] }),
    );
    const { result } = setup();
    act(() => result.current.acknowledgeCorrections());
    expect(result.current.items[0].corrected).toBeFalsy();
    expect(stored().items[0].corrected).toBeFalsy();
    expect(stored().items[0]).toMatchObject({ qty: 2, boxes: 0, pieces: 2 });
  });
});

describe("S2: re-adding merges by Cases, taking the boxed side's pack", () => {
  const bare = { productId: "p1", qty: 1, name: "Widget", unit: "each" } as CartItem;

  it("a bare incoming qty (a dashboard Add) on a boxed Case line adds ONE CASE, not one piece", () => {
    const { result } = setup();
    act(() => result.current.addItem(caseLine()));
    act(() => result.current.addItem(bare));
    expect(result.current.items[0]).toMatchObject({ qty: 24, boxes: 2, pieces: 0 });
  });

  it("a bare stored line merged with a boxed incoming one takes the incoming pack, in Cases", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ items: [{ productId: "p1", name: "Widget", unit: "each", qty: 2 }] }),
    );
    const { result } = setup();
    act(() => result.current.addItem(caseLine({ unitsPerBox: 6, qty: 6, boxes: 1 })));
    expect(result.current.items[0]).toMatchObject({ unitsPerBox: 6, qty: 18, boxes: 3, pieces: 0 });
  });

  it("two boxed sides with different packs: the incoming (current catalog) pack wins; a stored Case line keeps its Case count", () => {
    const { result } = setup();
    act(() => result.current.addItem(caseLine({ qty: 24, boxes: 2 })));
    act(() => result.current.addItem(caseLine({ unitsPerBox: 6, qty: 6, boxes: 1 })));
    expect(result.current.items[0]).toMatchObject({ unitsPerBox: 6, qty: 18, boxes: 3, pieces: 0 });
  });

  it("two boxed sides with different packs: a stored EACH line keeps its pieces (only a Case line keeps its Case count)", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ items: [caseLine({ qty: 14, boxes: 1, pieces: 2, sellBy: "EACH" })] }),
    );
    const { result } = setup();
    act(() => result.current.addItem(caseLine({ unitsPerBox: 6, qty: 6, boxes: 1 })));
    // 14 stored pieces (not 14/12 Cases) + the incoming 6-piece Case = 20 pieces of a 6-pack
    expect(result.current.items[0]).toMatchObject({
      unitsPerBox: 6,
      qty: 20,
      boxes: 3,
      pieces: 2,
      sellBy: "EACH",
    });
  });
});
