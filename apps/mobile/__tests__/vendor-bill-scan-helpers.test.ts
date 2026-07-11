import { buildBillDtoFromScan, mappingsFromScan, type SupplierRef } from "../lib/vendor-bill-scan";
import type { ScanResult } from "../lib/api/vendor-bills";

/**
 * Locks the ScanResult → create-bill DTO mapping to the API's actual field names
 * (extractedName / matchedProductId / supplier / invoiceDate). The screen previously
 * read supplierName/billDate/description/productId, all of which are undefined on the
 * real response — every mobile-scanned bill lost its supplier, dates, and matches.
 */

const suppliers: SupplierRef[] = [
  { id: "sup-1", name: "Metro Wholesale" },
  { id: "sup-2", name: "Cash & Carry" },
];

function scanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    supplier: "Metro Wholesale",
    invoiceNumber: "INV-100",
    invoiceDate: "2026-07-01",
    subtotal: 90,
    tax: 10,
    total: 100,
    items: [
      {
        extractedName: "Cola 24pk",
        qty: 2,
        unitCost: 20,
        lineTotal: 40,
        matchedProductId: "prod-1",
        matchedProductName: "Cola 24 Pack",
        confidence: "high",
      },
      {
        extractedName: "Mystery Snack",
        qty: 5,
        unitCost: 10,
        lineTotal: 50,
        matchedProductId: null,
        matchedProductName: null,
        confidence: "none",
      },
    ],
    ...overrides,
  };
}

describe("buildBillDtoFromScan", () => {
  it("maps API fields into the create-bill DTO (extractedName→description, matchedProductId→productId, invoiceDate→billDate)", () => {
    const dto = buildBillDtoFromScan(scanResult(), suppliers);
    expect(dto).toEqual({
      supplierId: "sup-1",
      billDate: "2026-07-01",
      notes: "AI scanned from Metro Wholesale",
      items: [
        { description: "Cola 24pk", productId: "prod-1", qty: 2, unitCost: 20 },
        { description: "Mystery Snack", productId: undefined, qty: 5, unitCost: 10 },
      ],
    });
  });

  it("resolves the supplier case-insensitively", () => {
    const dto = buildBillDtoFromScan(scanResult({ supplier: "cash & carry" }), suppliers);
    expect(dto.supplierId).toBe("sup-2");
  });

  it("keeps unmatched lines (no productId) instead of dropping them", () => {
    const dto = buildBillDtoFromScan(scanResult(), suppliers);
    expect(dto.items).toHaveLength(2);
    expect(dto.items[1].productId).toBeUndefined();
    expect(dto.items[1].description).toBe("Mystery Snack");
  });

  it("drops blank lines (no qty and no cost) and defaults qty 1 / cost 0", () => {
    const dto = buildBillDtoFromScan(
      scanResult({
        items: [
          {
            extractedName: "Empty row",
            qty: 0,
            unitCost: 0,
            lineTotal: null,
            matchedProductId: null,
            matchedProductName: null,
            confidence: "none",
          },
          {
            extractedName: "Cost only",
            qty: null,
            unitCost: 12.5,
            lineTotal: null,
            matchedProductId: null,
            matchedProductName: null,
            confidence: "none",
          },
        ],
      }),
      suppliers,
    );
    expect(dto.items).toEqual([
      { description: "Cost only", productId: undefined, qty: 1, unitCost: 12.5 },
    ]);
  });

  it("handles a missing supplier and suppliers list", () => {
    const dto = buildBillDtoFromScan(scanResult({ supplier: null }), undefined);
    expect(dto.supplierId).toBeUndefined();
    expect(dto.notes).toBeUndefined();
    expect(dto.billDate).toBe("2026-07-01");
  });

  it("omits billDate when the scan has no invoiceDate", () => {
    const dto = buildBillDtoFromScan(scanResult({ invoiceDate: null }), suppliers);
    expect(dto.billDate).toBeUndefined();
  });
});

describe("mappingsFromScan", () => {
  it("returns one mapping per matched line, keyed by the scanned supplier name", () => {
    expect(mappingsFromScan(scanResult())).toEqual([
      { supplierName: "Metro Wholesale", rawDescription: "Cola 24pk", productId: "prod-1" },
    ]);
  });

  it("returns nothing without a supplier name (server mapping key)", () => {
    expect(mappingsFromScan(scanResult({ supplier: "  " }))).toEqual([]);
  });

  it("skips unmatched lines", () => {
    const result = scanResult();
    result.items[0].matchedProductId = null;
    expect(mappingsFromScan(result)).toEqual([]);
  });
});
