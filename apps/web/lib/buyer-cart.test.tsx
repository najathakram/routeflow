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
