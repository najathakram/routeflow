import { InvoicesService } from "./invoices.service";

/**
 * #2717 M3 (SA-579 case 11, SA-589, SA-590): buildInvoiceItemData carries a FIXED order line's
 * composition onto the invoice line. The invoice components are frozen copies (name, sku,
 * barcode) of the ORDER line's component rows for the pieces THIS bill covers; there is no link
 * back to OrderItemComponent. `displayUnitPrice4` is computed per invoice line, from that line's
 * own net subtotal over the pieces it bills (never a line column, never the order's basis).
 */
const service = new (InvoicesService as unknown as new (...a: unknown[]) => InvoicesService)(
  ...Array(14).fill(undefined),
);
const build = (li: object, billQty: number, opts?: object, tenantId: string | null = "t-1") =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).buildInvoiceItemData(li, billQty, tenantId, opts);

const comp = (id: string, qty: number, position: number) => ({
  componentProductId: id,
  qty,
  name: `Name ${id}`,
  unitSku: `SKU-${id}`,
  unitBarcode: `0000${id}`,
  barcodeSymbology: "CODE128",
  displayUnitPrice4: 9.9999, // the ORDER row's price, never copied
  position,
});

const fixedLine = (o: Record<string, unknown> = {}) => ({
  id: "oi-1",
  productId: "recipe-p",
  qty: 48,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 24,
  unitPrice: 30,
  subtotal: 60,
  compositionMode: "FIXED",
  recipeId: "rec-1",
  recipeVersion: 3,
  components: [comp("a", 24, 0), comp("o", 24, 1)],
  product: { name: "Mixed Pack", unitsPerBox: 24 },
  ...o,
});

describe("buildInvoiceItemData carries a FIXED composition (case 11)", () => {
  it("a partial bill: provenance columns, components for the billed pieces, price on the invoice line's own net", () => {
    const line = build(fixedLine(), 24, { priorBilledQty: 0 });
    expect(line).toMatchObject({
      compositionMode: "FIXED",
      recipeId: "rec-1",
      recipeVersion: 3,
      subtotal: 30,
    });
    const rows = line.components.create;
    expect(rows.map((r: { qty: number }) => r.qty)).toEqual([12, 12]);
    expect(rows.map((r: { displayUnitPrice4: number }) => r.displayUnitPrice4)).toEqual([
      1.25, 1.25,
    ]);
    expect(rows[0]).toMatchObject({
      tenantId: "t-1",
      componentProductId: "a",
      name: "Name a",
      unitSku: "SKU-a",
      unitBarcode: "0000a",
      barcodeSymbology: "CODE128",
      position: 0,
    });
    expect(Object.keys(rows[0])).not.toContain("orderItemComponentId");
    expect(Object.keys(line)).not.toContain("displayUnitPrice4");
  });

  it("a full bill copies the components verbatim, price 60 / 48 = 1.25", () => {
    const line = build(fixedLine(), 48, { priorBilledQty: 0 });
    expect(line.components.create.map((r: { qty: number }) => r.qty)).toEqual([24, 24]);
    expect(line.components.create[0].displayUnitPrice4).toBe(1.25);
  });

  it("the second bill takes what the first left; the two bills sum to the order components", () => {
    const first = build(fixedLine(), 10, { priorBilledQty: 0 }).components.create;
    const second = build(fixedLine(), 38, { priorBilledQty: 10 }).components.create;
    const sum = (rows: Array<{ componentProductId: string; qty: number }>, id: string) =>
      rows.filter((r) => r.componentProductId === id).reduce((a, r) => a + r.qty, 0);
    expect(sum(first, "a") + sum(second, "a")).toBe(24);
    expect(sum(first, "o") + sum(second, "o")).toBe(24);
  });

  it("an unrounded float subtotal does not throw (lead condition 2)", () => {
    const li = fixedLine({
      qty: 24,
      boxes: 1,
      subtotal: 0.1 + 0.2,
      components: [comp("a", 12, 0), comp("o", 12, 1)],
    });
    expect(() => build(li, 24, { priorBilledQty: 0 })).not.toThrow();
    expect(build(li, 24, { priorBilledQty: 0 }).components.create[0].displayUnitPrice4).toBe(
      0.0125,
    );
  });

  it("a plain line gets none of the new keys (byte-identical to before)", () => {
    const plain = build(
      {
        ...fixedLine(),
        compositionMode: null,
        recipeId: null,
        recipeVersion: null,
        components: [],
      },
      48,
      { priorBilledQty: 0 },
    );
    for (const k of ["compositionMode", "recipeId", "recipeVersion", "components"]) {
      expect(Object.keys(plain)).not.toContain(k);
    }
  });

  it("components that no longer add up to the order line's pieces never block invoicing", () => {
    const stale = fixedLine({ components: [comp("a", 24, 0), comp("o", 23, 1)] });
    const line = build(stale, 48, { priorBilledQty: 0 });
    expect(line.subtotal).toBe(60);
    expect(Object.keys(line)).not.toContain("components");
  });

  it("no tenant id, no nested component rows (nested creates are not tenant-injected)", () => {
    const line = build(fixedLine(), 48, { priorBilledQty: 0 }, null);
    expect(Object.keys(line)).not.toContain("components");
  });
});
