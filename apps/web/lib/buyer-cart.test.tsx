import { act, renderHook } from "@testing-library/react";
import { useBuyerCart, type CartItem } from "./buyer-cart";

/**
 * Buyer cart box +/- (audit, money): a boxed line's qty, boxes and pieces must ALWAYS agree. Pricing reads boxes/pieces
 * (computeLineSubtotal ignores qty once they are set) while the cart shows and sends qty, so any path that moves one
 * without the others prices one quantity and orders another.
 */
const cola = (over: Partial<CartItem> = {}): CartItem => ({
  productId: "p1",
  name: "Cola",
  unit: "bottle",
  unitsPerBox: 12,
  qty: 24,
  boxes: 2,
  pieces: 0,
  ...over,
});

const hook = () => renderHook(() => useBuyerCart("buyer-1", "acme"));
const only = (r: ReturnType<typeof hook>) => r.result.current.items[0]!;

beforeEach(() => localStorage.clear());

describe("useBuyerCart: a boxed line keeps qty, boxes and pieces in step", () => {
  it("adding to an EXISTING boxed line (one more box from the catalog) updates the split, not just qty", () => {
    const r = hook();
    act(() => r.result.current.addItem(cola()));
    act(() => r.result.current.addItem(cola({ qty: 12, boxes: 1, pieces: 0 })));
    expect(only(r)).toMatchObject({ qty: 36, boxes: 3, pieces: 0 });
  });

  it("adding loose pieces rolls over into a box (24 + 5 + 7 -> 3 boxes, 0 loose; 24 + 5 -> 2 boxes + 5 loose)", () => {
    const r = hook();
    act(() => r.result.current.addItem(cola()));
    act(() => r.result.current.addItem(cola({ qty: 5, boxes: 0, pieces: 5 })));
    expect(only(r)).toMatchObject({ qty: 29, boxes: 2, pieces: 5 });
    act(() => r.result.current.addItem(cola({ qty: 7, boxes: 0, pieces: 7 })));
    expect(only(r)).toMatchObject({ qty: 36, boxes: 3, pieces: 0 });
  });

  it("setBoxesPieces REPLACES the split (box + from 2 -> 3 boxes = 36, never 60) and a zero split removes the line", () => {
    const r = hook();
    act(() => r.result.current.addItem(cola()));
    act(() => r.result.current.setBoxesPieces("p1", 3, 0));
    expect(only(r)).toMatchObject({ qty: 36, boxes: 3, pieces: 0 });
    act(() => r.result.current.setBoxesPieces("p1", 2, 5));
    expect(only(r)).toMatchObject({ qty: 29, boxes: 2, pieces: 5 });
    act(() => r.result.current.setBoxesPieces("p1", 0, 0));
    expect(r.result.current.items).toHaveLength(0);
  });

  it("setBoxesPieces normalises loose pieces >= a box into boxes", () => {
    const r = hook();
    act(() => r.result.current.addItem(cola()));
    act(() => r.result.current.setBoxesPieces("p1", 1, 30));
    expect(only(r)).toMatchObject({ qty: 42, boxes: 3, pieces: 6 });
  });

  it("updateQty on a boxed line re-derives boxes/pieces (30 pieces = 2 boxes + 6 loose)", () => {
    const r = hook();
    act(() => r.result.current.addItem(cola()));
    act(() => r.result.current.updateQty("p1", 30));
    expect(only(r)).toMatchObject({ qty: 30, boxes: 2, pieces: 6 });
  });

  it("a plain (non-boxed) line is unchanged: qty adds, updateQty sets, no split appears", () => {
    const r = hook();
    const plain: CartItem = { productId: "p2", name: "Bag", unit: "each", qty: 2 };
    act(() => r.result.current.addItem(plain));
    act(() => r.result.current.addItem({ ...plain, qty: 3 }));
    expect(only(r)).toMatchObject({ qty: 5 });
    expect(only(r).boxes).toBeUndefined();
    act(() => r.result.current.updateQty("p2", 9));
    expect(only(r)).toMatchObject({ qty: 9 });
    expect(only(r).boxes).toBeUndefined();
  });

  it("the stored cart carries the same consistent split (what a reload reads back)", () => {
    const r = hook();
    act(() => r.result.current.addItem(cola()));
    act(() => r.result.current.setBoxesPieces("p1", 3, 4));
    const stored = JSON.parse(localStorage.getItem("buyerCart_buyer-1_acme")!);
    expect(stored.items[0]).toMatchObject({ qty: 40, boxes: 3, pieces: 4 });
  });
});

describe("the buyer cart page's box edits REPLACE the split (B999 wiring)", () => {
  const page = require("fs").readFileSync(
    require("path").join(__dirname, "..", "app", "buyer", "portal", "[seller]", "cart", "page.tsx"),
    "utf8",
  ) as string;

  it("the box/pieces controls call setBoxesPieces and never addItem (which ADDS onto the existing qty)", () => {
    expect(page.match(/cart\.setBoxesPieces\(/g)?.length).toBe(4);
    expect(page).not.toMatch(/cart\.addItem\(/);
  });

  it("a typed zero is ignored (keepEmpty), only the minus button removes the line", () => {
    expect(page.match(/keepEmpty: true/g)?.length).toBe(2);
  });
});

describe("setBoxesPieces keepEmpty (a typed zero changes nothing)", () => {
  it("keeps the line unchanged when the typed split is empty; the minus path removes it", () => {
    const r = hook();
    act(() => r.result.current.addItem(cola()));
    act(() => r.result.current.setBoxesPieces("p1", 0, 0, { keepEmpty: true }));
    expect(only(r)).toMatchObject({ qty: 24, boxes: 2, pieces: 0 });
    act(() => r.result.current.setBoxesPieces("p1", 0, 0));
    expect(r.result.current.items).toHaveLength(0);
  });
});
