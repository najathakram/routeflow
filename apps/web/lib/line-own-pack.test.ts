import { lineDisplayPack, lineOwnPack } from "./line-own-pack";

const base = {
  productId: "p1",
  unitPrice: 10,
  unitsPerBox: null,
  unitLabel: null,
  promoFreeUnits: 0,
  product: { unitsPerBox: 24 },
};

describe("lineOwnPack (SA-1097 A-6: the split evidence is boxes OR pieces)", () => {
  it("{boxes null, pieces 6} priced at the live 24-pack (2.50) reads the live pack", () => {
    const li = { ...base, qty: 6, boxes: null, pieces: 6, subtotal: 2.5 };
    expect(lineOwnPack(li)).toEqual({ kind: "pack", pack: 24 });
    expect(lineDisplayPack(li)).toBe(24);
  });

  it("{boxes null, pieces 6} priced as plain units (60.00) was sold with no pack", () => {
    const li = { ...base, qty: 6, boxes: null, pieces: 6, subtotal: 60 };
    expect(lineOwnPack(li)).toEqual({ kind: "none" });
    expect(lineDisplayPack(li)).toBeNull();
  });

  it("{boxes null, pieces 6} whose money fits neither pack is unreadable", () => {
    expect(lineOwnPack({ ...base, qty: 6, boxes: null, pieces: 6, subtotal: 7 })).toEqual({
      kind: "unreadable",
    });
  });

  it("a zero-priced {boxes 0, pieces 6} line reads the live pack (nothing to misread)", () => {
    expect(
      lineOwnPack({ ...base, unitPrice: 0, qty: 6, boxes: 0, pieces: 6, subtotal: 0 }),
    ).toEqual({ kind: "pack", pack: 24 });
  });

  it("guards: no split at all, a snapshot, a unit label or no product stay as-stored", () => {
    expect(lineOwnPack({ ...base, qty: 6, boxes: null, pieces: null, subtotal: 2.5 })).toEqual({
      kind: "as-stored",
    });
    expect(
      lineOwnPack({ ...base, unitsPerBox: 12, qty: 12, boxes: 1, pieces: 0, subtotal: 10 }),
    ).toEqual({ kind: "as-stored" });
    expect(
      lineOwnPack({ ...base, unitLabel: "case", qty: 6, boxes: null, pieces: 6, subtotal: 2.5 }),
    ).toEqual({ kind: "as-stored" });
    expect(
      lineOwnPack({ ...base, productId: null, qty: 6, boxes: null, pieces: 6, subtotal: 2.5 }),
    ).toEqual({ kind: "as-stored" });
  });
});
