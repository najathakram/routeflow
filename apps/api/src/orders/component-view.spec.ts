import { toLineComponentView, toLineComponentViews } from "./component-view";

/**
 * #2717 M3: the read mapper for a frozen component row. Prisma hands a Decimal (or a string over
 * the wire) for `displayUnitPrice4`; clients get a plain number or null, sorted by position.
 */
describe("toLineComponentView", () => {
  it("coerces the Decimal price and keeps the snapshot fields", () => {
    const view = toLineComponentView({
      id: "c1",
      componentProductId: "p1",
      name: "Almond",
      qty: 12,
      unitSku: "ALM",
      unitBarcode: "0123",
      barcodeSymbology: "CODE128",
      displayUnitPrice4: { toString: () => "0.6250" } as never,
      position: 0,
      tenantId: "t-1",
      orderItemId: "oi-1",
    } as never);
    expect(view).toEqual({
      id: "c1",
      componentProductId: "p1",
      name: "Almond",
      qty: 12,
      unitSku: "ALM",
      unitBarcode: "0123",
      barcodeSymbology: "CODE128",
      displayUnitPrice4: 0.625,
      position: 0,
    });
  });

  it("a null price stays null (never 0)", () => {
    const v = toLineComponentView({
      componentProductId: "p1",
      name: "A",
      qty: 1,
      unitSku: null,
      unitBarcode: null,
      barcodeSymbology: null,
      displayUnitPrice4: null,
      position: 0,
    } as never);
    expect(v.displayUnitPrice4).toBeNull();
  });

  it("toLineComponentViews sorts by position and maps a missing list to none", () => {
    const rows = [
      { componentProductId: "b", name: "B", qty: 1, position: 1, displayUnitPrice4: 1 },
      { componentProductId: "a", name: "A", qty: 1, position: 0, displayUnitPrice4: 1 },
    ];
    expect(toLineComponentViews(rows as never).map((v) => v.componentProductId)).toEqual(["a", "b"]);
    expect(toLineComponentViews(undefined)).toEqual([]);
    expect(toLineComponentViews(null)).toEqual([]);
  });
});
