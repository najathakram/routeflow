import * as fs from "fs";
import * as path from "path";
import { BUYER_QTY_SPLIT_MISMATCH_COPY, isQtySplitMismatch } from "../lib/buyer-qty-split";
import { useCartStore } from "../store/cartStore";

/**
 * Row 531 on mobile. The customer cart already steps in whole boxes and writes its split through
 * ONE function (`boxedFields`), so it cannot drift the way web's did; these tests pin that
 * invariant (qty === boxes * pack + pieces after EVERY operation) and the fixed copy for the
 * server's coded refusal.
 */
const boxed = { productId: "p1", name: "Widget", unitPrice: 15.6, unit: "case", unitsPerBox: 12 };
const loose = { productId: "p2", name: "Loose", unitPrice: 3, unit: "each", unitsPerBox: null };

beforeEach(() => useCartStore.getState().clear());

function expectConsistent() {
  for (const i of useCartStore.getState().items) {
    const upb = Number(i.unitsPerBox ?? 0);
    if (upb > 1) {
      expect(i.qty).toBe((i.boxes ?? 0) * upb + (i.pieces ?? 0));
      expect(i.pieces).toBe(0);
    } else {
      expect(i.boxes).toBeNull();
      expect(i.pieces).toBeNull();
    }
  }
}

describe("customer cart: qty and the box split never disagree", () => {
  it("holds after every add / step / typed count, for boxed and plain lines", () => {
    const s = useCartStore.getState();
    s.add(boxed);
    s.add(loose);
    expectConsistent();
    for (const n of [2, 5, 11, 12, 13, 24, 25]) {
      s.setUnits("p1", n);
      expectConsistent();
      expect(useCartStore.getState().items.find((i) => i.productId === "p1")).toMatchObject({
        boxes: n,
        pieces: 0,
        qty: n * 12,
      });
    }
    s.step("p1", -3);
    expectConsistent();
    s.add(boxed);
    expectConsistent();
    s.setUnits("p2", 7);
    expect(useCartStore.getState().items.find((i) => i.productId === "p2")).toMatchObject({
      qty: 7,
      boxes: null,
    });
  });

  it("typing 2 on a 12/box line is 2 boxes (24 pieces), priced as 2 boxes", () => {
    const s = useCartStore.getState();
    s.add(boxed);
    s.setUnits("p1", 2);
    expect(useCartStore.getState().items[0]).toMatchObject({ qty: 24, boxes: 2, pieces: 0 });
    expect(useCartStore.getState().total()).toBe(31.2);
  });
});

describe("QTY_SPLIT_MISMATCH on mobile", () => {
  it("the copy is the one fixed sentence (the same literal as web's)", () => {
    expect(BUYER_QTY_SPLIT_MISMATCH_COPY).toBe(
      "Your cart changed. Review the quantities and try again.",
    );
  });

  it("recognises only the coded 400", () => {
    const err = (status: number, code: string) => ({ response: { status, data: { code } } });
    expect(isQtySplitMismatch(err(400, "QTY_SPLIT_MISMATCH"))).toBe(true);
    expect(isQtySplitMismatch(err(409, "QTY_SPLIT_MISMATCH"))).toBe(false);
    expect(isQtySplitMismatch(err(400, "DUPLICATE_LINE_ID"))).toBe(false);
    expect(isQtySplitMismatch(null)).toBe(false);
    expect(isQtySplitMismatch(new Error("x"))).toBe(false);
  });

  it("the cart screen shows the fixed copy for it, never the server's message", () => {
    const src = fs.readFileSync(path.join(__dirname, "../app/(customer)/orders/cart.tsx"), "utf8");
    expect(src).toContain("isQtySplitMismatch(e)");
    expect(src).toContain("BUYER_QTY_SPLIT_MISMATCH_COPY");
  });
});
