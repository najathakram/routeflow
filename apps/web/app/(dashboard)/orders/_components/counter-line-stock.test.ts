import { lineStockViews } from "@/lib/line-stock";
import { stockLineOfSaleLine } from "./counter-line-stock";
import { toSaleItem } from "./counter-sale-line-edit";
import type { SaleLine } from "./counter-sale-scan";

/**
 * SA-1086 PR-2 (CQ-13, LS-9): the counter row reads the same stock as New Order, from the line AS THE SALE WILL SEND IT
 * (`toSaleItem`), so the note counts what the save counts.
 */
const line = (extra: Partial<SaleLine>): SaleLine => ({
  tempId: "t1",
  productId: "p1",
  name: "Soda",
  unitPrice: 10,
  qty: 1,
  ...extra,
});

const view = (l: SaleLine, onHand: number, allowOversell = true) =>
  lineStockViews({
    lines: [stockLineOfSaleLine(l)],
    availability: { allowOversell, items: [{ productId: l.productId, availablePieces: onHand }] },
    failed: false,
    fetching: false,
  }).get(l.tempId);

describe("stockLineOfSaleLine", () => {
  it("M1: 1 box and 8 pieces of a 12-pack reads as 20 pieces, the way toSaleItem sends it", () => {
    const l = line({ unitsPerBox: 12, boxes: 1, pieces: 8, qty: 20, unit: "case" });
    const s = stockLineOfSaleLine(l);
    expect(s).toMatchObject({ key: "t1", productId: "p1", qty: 20, boxes: 1, pieces: 8 });
    expect(s.unitsPerBox).toBe(12);
    const sent = toSaleItem(l);
    expect(s.qty).toBe(sent.qty);
    expect(s.boxes).toBe(sent.boxes);
    expect(s.pieces).toBe(sent.pieces);
  });

  it("M2: a plain line is its qty, with no box split, and carries the product's words", () => {
    const s = stockLineOfSaleLine(
      line({ qty: 3, unit: "each", packLabel: "Tray", baseLabel: "can" }),
    );
    expect(s).toMatchObject({ qty: 3, boxes: null, pieces: null, unit: "each" });
    expect(s.packLabel).toBe("Tray");
    expect(s.baseLabel).toBe("can");
    expect(s.unitLabel).toBeFalsy();
  });

  it("M3: a boxed line holding only a qty is split like the save splits it (24 = 2 boxes)", () => {
    const l = line({ unitsPerBox: 12, qty: 24 });
    expect(stockLineOfSaleLine(l)).toMatchObject({ qty: 24, boxes: 2, pieces: 0 });
  });

  it("M4: 2 boxes of a 12-pack with 20 on hand is over (24 > 20), told as 1 box and 8 pieces", () => {
    const v = view(line({ unitsPerBox: 12, boxes: 2, pieces: 0, qty: 24 }), 20);
    expect(v).toMatchObject({ state: "ready", level: "low", label: "1 box and 8 pieces left" });
  });

  it("M5: nothing on hand is 'out', and the same two lines of one product count together", () => {
    expect(view(line({ qty: 1 }), 0)).toMatchObject({ level: "out" });
    const both = lineStockViews({
      lines: [
        stockLineOfSaleLine(line({ tempId: "a", qty: 6 })),
        stockLineOfSaleLine(line({ tempId: "b", qty: 6 })),
      ],
      availability: { allowOversell: true, items: [{ productId: "p1", availablePieces: 10 }] },
      failed: false,
      fetching: false,
    });
    expect(both.get("a")).toMatchObject({ level: "low", requestedPieces: 12 });
    expect(both.get("b")).toMatchObject({ level: "low" });
  });
});
