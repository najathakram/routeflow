import { toLineComponentView, toLineComponentViews, withComponentViews } from "./component-view";

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
    expect(toLineComponentViews(rows as never).map((v) => v.componentProductId)).toEqual([
      "a",
      "b",
    ]);
    expect(toLineComponentViews(undefined)).toEqual([]);
    expect(toLineComponentViews(null)).toEqual([]);
  });
});

describe("withComponentViews (the findOne wiring)", () => {
  // Fixtures carry tenant/parent keys and a Decimal-like price on purpose; widen the input type.
  const withViews = withComponentViews as (lines: unknown) => unknown;
  const row = (position: number, price: unknown) => ({
    id: `c${position}`,
    componentProductId: `p${position}`,
    name: `N${position}`,
    qty: 12,
    displayUnitPrice4: price,
    position,
    tenantId: "t-1",
    orderItemId: "li-1",
  });

  it("maps every line's components to views: a number price, position order, no tenant or parent key", () => {
    const out = withViews([
      {
        id: "li-1",
        subtotal: 30,
        components: [row(1, { toString: () => "0.6250" }), row(0, null)],
      },
    ]) as Array<{ id: string; subtotal: number; components: Array<Record<string, unknown>> }>;
    expect(out[0].id).toBe("li-1");
    expect(out[0].subtotal).toBe(30);
    expect(out[0].components.map((c) => c.position)).toEqual([0, 1]);
    expect(out[0].components[0].displayUnitPrice4).toBeNull();
    expect(out[0].components[1].displayUnitPrice4).toBe(0.625);
    expect(out[0].components[1]).not.toHaveProperty("tenantId");
    expect(out[0].components[1]).not.toHaveProperty("orderItemId");
  });

  it("a line with no components key stays exactly as it was (plain lines, byte-identical)", () => {
    const plain = { id: "li-2", qty: 1 };
    const out = withViews([plain]) as Array<object>;
    expect(out[0]).toBe(plain);
    expect(withViews(undefined)).toBeUndefined();
  });
});
