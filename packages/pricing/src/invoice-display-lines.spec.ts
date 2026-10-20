import {
  invoiceDisplayCategoryTax,
  displayUnitForItem,
  displayUnitSnapshotOf,
  invoiceDisplayLines,
  invoiceDisplayUnitFor,
} from "./invoice-display-lines";
import { componentSubLineText } from "./component-pieces";
import { buildLadderView } from "./price-ladder";

const PIECES = { kind: "pieces", label: "Piece" } as const;
const LEGACY = { kind: "legacy", label: null } as const;

const item = {
  description: "Acme Mixed Box",
  qty: 30,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 15,
  unitPrice: 30.01,
  subtotal: 60.02,
};
const comps = [
  { componentProductId: "a2", name: "Acme A2", qty: 20, position: 1 },
  { componentProductId: "a1", name: "Acme A1", qty: 10, position: 0, unitSku: "A1-P" },
];

describe("invoiceDisplayLines", () => {
  it("P1: components layout, largest-remainder amounts sum to the box subtotal", () => {
    const r = invoiceDisplayLines(item, comps, PIECES);
    expect(r.layout).toBe("components");
    if (r.layout !== "components") return;
    expect(r.rows.map((x) => x.componentProductId)).toEqual(["a1", "a2"]);
    expect(r.rows[0]).toMatchObject({
      qty: 10,
      amount: 20.01,
      unitPrice: 2.001,
      unitLabel: "Piece",
    });
    expect(r.rows[1]).toMatchObject({ qty: 20, amount: 40.01, unitPrice: 2.0005 });
    expect(r.rows[0].amount + r.rows[1].amount).toBeCloseTo(60.02, 10);
    expect(r.groupTotal).toEqual({ description: "Acme Mixed Box", amount: 60.02 });
    expect(r.categoryTax).toBeNull();
  });
  it("category tax becomes one row", () => {
    const r = invoiceDisplayLines(
      { ...item, categoryTax: { name: "Tobacco", amount: 3.5 } },
      comps,
      PIECES,
    );
    expect(r.layout === "components" && r.categoryTax).toEqual({
      label: "Tobacco tax",
      amount: 3.5,
    });
  });
  it("drops zero-qty rows", () => {
    const r = invoiceDisplayLines(
      item,
      [...comps, { componentProductId: "z", name: "Z", qty: 0, position: 2 }],
      PIECES,
    );
    expect(r.layout === "components" && r.rows.length).toBe(2);
  });
  it("P6: no components -> pieces layout", () => {
    expect(invoiceDisplayLines(item, null, PIECES)).toEqual({
      layout: "pieces",
      qty: 30,
      unitLabel: "Piece",
      unitPrice: 2.0007,
      amount: 60.02,
    });
  });
  it("P6: sum mismatch -> pieces layout", () => {
    const bad = [{ ...comps[1], qty: 9 }, comps[0]];
    expect(invoiceDisplayLines(item, bad, PIECES).layout).toBe("pieces");
  });
  it("non-split, unitLabel, non-pieces -> today", () => {
    expect(invoiceDisplayLines({ ...item, boxes: null, pieces: null }, comps, PIECES).layout).toBe(
      "today",
    );
    expect(invoiceDisplayLines({ ...item, unitLabel: "Case" }, comps, PIECES).layout).toBe("today");
    expect(invoiceDisplayLines(item, comps, null).layout).toBe("today");
  });
  it("legacy unit -> today with subLines equal to componentSubLineText in position order", () => {
    const r = invoiceDisplayLines(item, comps, LEGACY);
    expect(r).toEqual({
      layout: "today",
      subLines: [
        componentSubLineText({ name: "Acme A1", qty: 10, unitSku: "A1-P" }),
        componentSubLineText({ name: "Acme A2", qty: 20 }),
      ],
    });
  });
  it("never throws on junk", () => {
    expect(() =>
      invoiceDisplayLines({ ...item, subtotal: Number.NaN }, comps, PIECES),
    ).not.toThrow();
    expect(invoiceDisplayLines({ ...item, subtotal: 60.025 }, comps, PIECES).layout).toBe("pieces");
  });
});

describe("invoiceDisplayUnitFor", () => {
  const view = buildLadderView(
    { unitsPerBox: 15, unit: "Box", baseUnitLabel: "Piece" } as never,
    [],
  );
  it("customer default", () => {
    expect(invoiceDisplayUnitFor({ customerDefault: "PIECES", scopes: {}, view: null })).toEqual(
      PIECES,
    );
    expect(
      invoiceDisplayUnitFor({ customerDefault: "PACK", scopes: { business: "smallest" }, view }),
    ).toEqual(LEGACY);
  });
  it("customer PIECES beats a product 'pack' ref; customer PACK beats a customer 'base' ref", () => {
    expect(
      invoiceDisplayUnitFor({ customerDefault: "PIECES", scopes: { product: "pack" }, view }),
    ).toEqual(PIECES);
    expect(
      invoiceDisplayUnitFor({ customerDefault: "PACK", scopes: { customer: "base" }, view }),
    ).toEqual(LEGACY);
  });
  it("scopes", () => {
    expect(
      invoiceDisplayUnitFor({ customerDefault: "LEGACY", scopes: { business: "smallest" }, view }),
    ).toEqual(PIECES);
    expect(
      invoiceDisplayUnitFor({ scopes: { customer: "pack", business: "smallest" }, view }),
    ).toEqual(LEGACY);
    expect(invoiceDisplayUnitFor({ scopes: {}, view })).toEqual(LEGACY);
    expect(
      invoiceDisplayUnitFor({
        customerDefault: "LEGACY",
        scopes: { business: "smallest" },
        view: null,
      }),
    ).toEqual(LEGACY);
  });
});

describe("snapshot codec", () => {
  it("displayUnitForItem", () => {
    expect(displayUnitForItem("DRAFT", { label: null, factor: null }, PIECES)).toEqual(PIECES);
    expect(displayUnitForItem("SENT", { label: "Piece", factor: 1 }, LEGACY)).toEqual(PIECES);
    expect(displayUnitForItem("SENT", { label: null, factor: null }, PIECES)).toEqual(LEGACY);
    expect(displayUnitForItem("PAID", { label: "Box", factor: 15 }, PIECES)).toEqual(LEGACY);
  });
  it("displayUnitSnapshotOf writes the pieces kind only; legacy is null (the column stays empty)", () => {
    expect(displayUnitSnapshotOf(PIECES)).toEqual({ label: "Piece", factor: 1 });
    expect(displayUnitSnapshotOf({ kind: "pieces", label: "Each" })).toEqual({
      label: "Each",
      factor: 1,
    });
    expect(displayUnitSnapshotOf({ kind: "pieces", label: null })).toEqual({
      label: "Piece",
      factor: 1,
    });
    expect(displayUnitSnapshotOf(LEGACY)).toBeNull();
  });
});

describe("invoiceDisplayCategoryTax", () => {
  it("maps the stored levy and its category name; none when zero", () => {
    expect(
      invoiceDisplayCategoryTax({
        categoryTaxAmount: "3.50",
        trackedCategory: { name: "Tobacco" },
      }),
    ).toEqual({ name: "Tobacco", amount: 3.5 });
    expect(invoiceDisplayCategoryTax({ categoryTaxAmount: 2, trackedCategory: null })).toEqual({
      name: "Category",
      amount: 2,
    });
    expect(invoiceDisplayCategoryTax({ categoryTaxAmount: 0 })).toBeNull();
    expect(invoiceDisplayCategoryTax({ categoryTaxAmount: null })).toBeNull();
  });
});
