import * as fs from "fs";
import * as path from "path";
import { barcodeRowsToView, printableUnitBarcode } from "./product-barcode-rules";
import { findScanMatches } from "./scan-match";
import { invoiceItemCode } from "../invoices/invoice-item-code";
import { syncProductBarcodesFromLegacy } from "./product-catalog-sync";

/**
 * Units U-2 (SA-729g b/c/d): a ladder level's own barcode row (productUnitId set) must not leak into any reader
 * that predates it. These pin TODAY's behaviour; U-8 changes the scan on purpose and edits (d) in the same diff.
 */
const ladderRow = {
  id: "b-l1",
  productId: "p1",
  tenantId: "t",
  code: "LAD-1",
  level: "UNIT",
  primaryFor: "UNIT",
  symbology: "OTHER",
  origin: "ENTERED",
  copiedFromLevel: null,
  productUnitId: "u1",
};

describe("ladder barcode rows vs the older readers", () => {
  it("(b) the product view carries productUnitId on each DB row", () => {
    const view = barcodeRowsToView([
      { ...ladderRow, level: "CASE", primaryFor: null } as never,
      { ...ladderRow, id: "b2", code: "UNIT-1", productUnitId: null } as never,
    ]);
    expect(view.map((v) => v.productUnitId)).toEqual(["u1", null]);
  });

  it("(c) printableUnitBarcode ignores a ladder row, even one shaped like the UNIT primary", () => {
    expect(printableUnitBarcode([ladderRow])).toBeNull();
    expect(
      printableUnitBarcode([ladderRow, { ...ladderRow, code: "OWN", productUnitId: null }]),
    ).toBe("OWN");
  });

  it("(c) invoiceItemCode reads product columns only", () => {
    expect(invoiceItemCode({ unitSku: "U", barcode: "B", sku: "S" })).toBe("U");
    expect(invoiceItemCode.length).toBe(1);
  });

  it("(c) the packing slip selects product columns, never barcode rows", () => {
    const src = fs.readFileSync(path.join(__dirname, "../orders/packing-slip-data.ts"), "utf8");
    expect(src).not.toMatch(/barcodes/);
  });

  it("(c) the legacy barcode sync neither reads nor deletes ladder rows", async () => {
    const calls: Array<{ op: string; where: Record<string, unknown> }> = [];
    const tx = {
      $executeRaw: jest.fn(),
      productBarcode: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(async ({ where }) => (calls.push({ op: "find", where }), [])),
        deleteMany: jest.fn(
          async ({ where }) => (calls.push({ op: "delete", where }), { count: 0 }),
        ),
        createMany: jest.fn(),
      },
      product: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await syncProductBarcodesFromLegacy(tx, {
      tenantId: "t",
      productId: "p1",
      barcode: "999",
      unitsPerBox: 12,
    });
    for (const c of calls) expect(c.where.productUnitId).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it("(d) today's scan: a ladder code finds the product with levels [] (so the default unit applies)", async () => {
    const product = {
      id: "p1",
      name: "Soda",
      sku: null,
      unitSku: null,
      barcode: null,
      unitsPerBox: 24,
      barcodes: [{ ...ladderRow, level: "CASE", primaryFor: null }],
    };
    const db = {
      productBarcode: {
        findMany: jest.fn().mockResolvedValue([{ ...ladderRow, level: "CASE", primaryFor: null }]),
      },
      product: { findMany: jest.fn().mockResolvedValue([product]) },
    };
    const res = await findScanMatches(db, ["LAD-1"]);
    expect(res?.product.id).toBe("p1");
    expect(res?.scanMatch).toEqual({ code: "LAD-1", levels: [] });
  });
});
