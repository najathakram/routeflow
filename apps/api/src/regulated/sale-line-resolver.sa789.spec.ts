import { readFileSync } from "fs";
import { join } from "path";
import { resolveSaleLines } from "./sale-line-resolver";

/**
 * SA-789 R-P1: no reader of `RegulatedSalesLedger` may map a ledger row's `invoiceItemId` to an item
 * on its own; it goes through `resolveSaleLines` (invoice item first, then the order line).
 * A source scan with a detector self-test (like addon-lockheld-single-caller.sa769.spec.ts).
 */

const READERS = [
  "regulated-ledger.service.ts",
  "regulated-report.service.ts",
  "regulated-filing.service.ts",
  "regulated.service.ts",
  "parked-reversals.ts",
  "parked-reversal-resolution.service.ts",
];

/** Direct item reads in a source file (the pattern a ledger-id -> item mapping would use). */
export function directItemReads(source: string): number {
  return (
    source.match(/\b(invoiceItem|orderItem)\s*\.\s*(findMany|findFirst|findUnique)\s*\(/g) ?? []
  ).length;
}

/** The ONLY allowed direct item read outside the resolver: the credit-note path reads the CREDITED
 *  invoice item (not a ledger row id) to learn its order line. */
const ALLOWED: Record<string, number> = { "regulated-ledger.service.ts": 1 };

describe("SA-789 R-P1: ledger readers resolve lines only through resolveSaleLines", () => {
  it("the detector flags a planted bypass and ignores clean source", () => {
    expect(directItemReads("await db.invoiceItem.findMany({ where: { id: { in: ids } } })")).toBe(
      1,
    );
    expect(directItemReads("await db.orderItem.findFirst({})")).toBe(1);
    expect(directItemReads("await resolveSaleLines(db, sales)")).toBe(0);
  });

  it("scans a non-empty set of readers and finds no bypass", () => {
    let scanned = 0;
    for (const file of READERS) {
      const source = readFileSync(join(__dirname, file), "utf8");
      scanned++;
      expect({ file, reads: directItemReads(source) }).toEqual({
        file,
        reads: ALLOWED[file] ?? 0,
      });
    }
    expect(scanned).toBeGreaterThan(0);
  });
});

describe("resolveSaleLines", () => {
  const sale = { id: "s1", invoiceItemId: "ii-old", orderItemId: "oi-1" };
  const row = (over: Record<string, unknown> = {}) => ({
    id: "x",
    qty: 75,
    boxes: null,
    pieces: null,
    unitLabel: null,
    unitsPerBox: null,
    productId: "p1",
    ...over,
  });

  it("prefers the live invoice item", async () => {
    const db = {
      invoiceItem: { findMany: jest.fn().mockResolvedValue([row({ id: "ii-old" })]) },
      orderItem: { findMany: jest.fn().mockResolvedValue([row({ id: "oi-1", productId: "p2" })]) },
    };
    const out = (await resolveSaleLines(db, [sale])).get("s1");
    expect(out).toMatchObject({
      productId: "p1",
      liveInvoiceItemId: "ii-old",
      viaOrderItem: false,
    });
  });

  it("falls back to the order line when the invoice item is gone", async () => {
    const db = {
      invoiceItem: { findMany: jest.fn().mockResolvedValue([]) },
      orderItem: { findMany: jest.fn().mockResolvedValue([row({ id: "oi-1", productId: "p2" })]) },
    };
    const out = (await resolveSaleLines(db, [sale])).get("s1");
    expect(out).toMatchObject({ productId: "p2", liveInvoiceItemId: null, viaOrderItem: true });
  });

  it("resolves to null when neither source has the line", async () => {
    const db = {
      invoiceItem: { findMany: jest.fn().mockResolvedValue([]) },
      orderItem: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const out = (await resolveSaleLines(db, [sale])).get("s1");
    expect(out).toMatchObject({ line: null, productId: null, liveInvoiceItemId: null });
  });
});
