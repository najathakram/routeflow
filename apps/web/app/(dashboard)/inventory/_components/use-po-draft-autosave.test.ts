import {
  buildPoDraftPayload,
  poDraftMeta,
  poDraftParkable,
  type PoDraftLine,
  type PoDraftState,
} from "./use-po-draft-autosave";

// SA-1222 PR-A item 5: the PO draft's payload is v1, carries each line's box size as saved, parks only real work, and
// never puts the supplier in the customer fields.
const line = (over: Partial<PoDraftLine> = {}): PoDraftLine => ({
  productId: "",
  qty: "",
  unitCost: "",
  boxes: "",
  pieces: "",
  unitsPerBox: null,
  ...over,
});
const state = (over: Partial<PoDraftState> = {}): PoDraftState => ({
  supplierId: "",
  supplierName: null,
  expectedDate: "",
  notes: "",
  lines: [line()],
  ...over,
});

describe("PO draft payload and meta (SA-1222)", () => {
  it("an empty form is not parkable; a supplier alone, or one product line alone, is", () => {
    expect(poDraftParkable(state())).toBe(false);
    expect(poDraftParkable(state({ supplierId: "sup-1" }))).toBe(true);
    expect(poDraftParkable(state({ lines: [line(), line({ productId: "p1" })] }))).toBe(true);
  });

  it("the payload is v1 with the typed figures and each line's unitsPerBox as saved, costs untouched", () => {
    const p = buildPoDraftPayload(
      state({
        supplierId: "sup-1",
        expectedDate: "2026-12-01",
        notes: "Dock 3",
        lines: [
          line({ productId: "p1", boxes: "2", pieces: "0", unitCost: "11.00", unitsPerBox: 12 }),
        ],
      }),
    );
    expect(p).toEqual({
      v: 1,
      supplierId: "sup-1",
      expectedDate: "2026-12-01",
      notes: "Dock 3",
      lines: [
        { productId: "p1", qty: "", unitCost: "11.00", boxes: "2", pieces: "0", unitsPerBox: 12 },
      ],
    });
  });

  it("the meta is kind PURCHASE_ORDER, the supplier name is the title, and no customer field exists", () => {
    const meta = poDraftMeta({ supplierName: " Acme Supply " });
    expect(meta.kind).toBe("PURCHASE_ORDER");
    expect(meta.title).toBe("Acme Supply");
    expect(meta).not.toHaveProperty("customerId");
    expect(meta).not.toHaveProperty("customerName");
  });
});
