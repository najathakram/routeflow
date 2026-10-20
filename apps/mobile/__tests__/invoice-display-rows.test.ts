import { readFileSync } from "fs";
import { join } from "path";
import { invoiceDisplayRowTexts } from "../lib/invoice-line-display";
import { componentSubLineTexts } from "../lib/line-components";

const boxItem = {
  description: "Acme Mixed Case",
  qty: 30,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 15,
  unitLabel: null,
  unitPrice: 30.01,
  subtotal: 60.02,
};
const comps = [
  {
    componentProductId: "a2",
    name: "Acme Widget Two",
    qty: 20,
    unitSku: null,
    unitBarcode: null,
    barcodeSymbology: null,
    displayUnitPrice4: null,
    position: 2,
  },
  {
    componentProductId: "a1",
    name: "Acme Widget One",
    qty: 10,
    unitSku: null,
    unitBarcode: null,
    barcodeSymbology: null,
    displayUnitPrice4: null,
    position: 1,
  },
];
const pieces = { kind: "pieces" as const, label: "Piece" };

describe("invoiceDisplayRowTexts", () => {
  it("P1: components layout gives rows (leading) then the tax line (trailing); the group is the card itself", () => {
    const r = invoiceDisplayRowTexts({
      ...boxItem,
      components: comps,
      displayUnit: pieces,
      categoryTax: { name: "Tobacco", amount: 3.5 },
    });
    expect(r.layout).toBe("components");
    expect(r.leading).toEqual([
      "Acme Widget One × 10 Pieces @ $2.0010 — $20.01",
      "Acme Widget Two × 20 Pieces @ $2.0005 — $40.01",
    ]);
    expect(r.trailing).toEqual(["Tobacco tax — $3.50"]);
    expect(r.subLines).toEqual([]);
    expect(r.pieces).toBeNull();
  });

  it("components rows keep SKU and barcode when present", () => {
    const withSku = invoiceDisplayRowTexts({
      ...boxItem,
      components: [{ ...comps[0], unitSku: "W-1", unitBarcode: "0123" }, comps[1]],
      displayUnit: pieces,
    });
    expect(withSku.leading[1]).toContain("SKU W-1");
    expect(withSku.leading[1]).toContain("0123");
    expect(withSku.leading[0]).not.toContain("SKU");
  });

  it("P6: no components gives the pieces qty and price swap only", () => {
    const r = invoiceDisplayRowTexts({ ...boxItem, components: null, displayUnit: pieces });
    expect(r).toEqual({
      layout: "pieces",
      leading: [],
      subLines: [],
      pieces: { qtyText: "30 Pieces", priceText: "$2.0007" },
      trailing: [],
    });
  });

  it("P6: components that do not sum to the line fall back to the pieces layout", () => {
    const r = invoiceDisplayRowTexts({ ...boxItem, components: [comps[1]], displayUnit: pieces });
    expect(r.layout).toBe("pieces");
  });

  it("legacy: today layout with sub-lines identical to componentSubLineTexts", () => {
    const r = invoiceDisplayRowTexts({
      ...boxItem,
      components: comps,
      displayUnit: { kind: "legacy", label: null },
    });
    expect(r.layout).toBe("today");
    expect(r.subLines).toEqual(componentSubLineTexts(comps));
    expect(r.leading).toEqual([]);
  });

  it("no displayUnit (old API) is today", () => {
    const r = invoiceDisplayRowTexts({ ...boxItem, components: comps });
    expect(r.layout).toBe("today");
    expect(r.subLines).toEqual(componentSubLineTexts(comps));
  });

  it("coerces Decimal strings from the wire", () => {
    const r = invoiceDisplayRowTexts({
      ...boxItem,
      qty: "30" as unknown as number,
      unitPrice: "30.0100" as unknown as number,
      subtotal: "60.0200" as unknown as number,
      components: null,
      displayUnit: pieces,
    });
    expect(r.pieces).toEqual({ qtyText: "30 Pieces", priceText: "$2.0007" });
  });
});

describe("mobile screens keep today's card lines in every layout (source pins)", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  const screens = [
    ["operator", "app/(operator)/(tabs)/invoices/[id].tsx"],
    ["customer", "app/(customer)/invoices/[id].tsx"],
  ] as const;
  it.each(screens)("%s: discount and notes are not gated on the layout", (_n, path) => {
    const src = read(path);
    expect(src).toMatch(/invoiceDisplayCategoryTax/);
    // rows come before the card's own lines, the tax line after them
    const iLead = src.indexOf("displayRows.leading");
    const iNotes =
      src.indexOf("{it.notes?.trim()") >= 0
        ? src.indexOf("{it.notes?.trim()")
        : src.indexOf("{item.notes?.trim()");
    const iTrail = src.indexOf("displayRows.trailing");
    expect(iLead).toBeGreaterThan(-1);
    expect(iNotes).toBeGreaterThan(iLead);
    expect(iTrail).toBeGreaterThan(iNotes);
    // the pieces swap replaces only the qty/price text
    expect(src).toMatch(/displayRows\.pieces/);
    // today's sub-lines render only in the today layout
    expect(src).toMatch(/displayRows\.subLines/);
  });
  it("customer: the discount text rides the meta line in the pieces layout too", () => {
    const src = read("app/(customer)/invoices/[id].tsx");
    expect(src).toMatch(/disc`/);
    expect(src).not.toMatch(/displayRows\.layout === "components" \? null/);
  });
});
