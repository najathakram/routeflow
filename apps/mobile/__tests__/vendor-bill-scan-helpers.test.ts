import {
  buildBillDtoFromScan,
  duplicateBillPrompt,
  mappingsFromScan,
  priorScanPrompt,
  scanBillTotal,
  unmatchedCount,
  linkScanItem,
  type SupplierRef,
} from "../lib/vendor-bill-scan";
import type {
  DuplicateVendorBillInfo,
  PriorScanSummary,
  ScanResult,
} from "../lib/api/vendor-bills";

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
      notes: "AI scanned from Metro Wholesale · Supplier invoice #INV-100",
      supplierInvoiceNumber: "INV-100",
      taxAmount: 10,
      subtotal: 90,
      items: [
        { description: "Cola 24pk", productId: "prod-1", qty: 2, unitCost: 20, lineTotal: 40 },
        { description: "Mystery Snack", productId: undefined, qty: 5, unitCost: 10, lineTotal: 50 },
      ],
    });
  });

  it("carries the per-line item code and pack size the invoice printed", () => {
    const result = scanResult();
    result.items[0].sku = "  MW-4471 ";
    result.items[0].packSize = 24;
    const dto = buildBillDtoFromScan(result, suppliers);
    expect(dto.items[0].sku).toBe("MW-4471");
    expect(dto.items[0].packSize).toBe(24);
    // Nothing invented for a line that printed neither.
    expect(dto.items[1].sku).toBeUndefined();
    expect(dto.items[1].packSize).toBeUndefined();
  });

  it("links the bill to the scan it was keyed from", () => {
    expect(buildBillDtoFromScan(scanResult({ scanId: "scan-9" }), suppliers).scanId).toBe("scan-9");
    expect(buildBillDtoFromScan(scanResult(), suppliers).scanId).toBeUndefined();
  });

  it("omits tax and subtotal rather than sending zeros the invoice never printed", () => {
    const dto = buildBillDtoFromScan(scanResult({ tax: null, subtotal: null }), suppliers);
    expect(dto.taxAmount).toBeUndefined();
    expect(dto.subtotal).toBeUndefined();
  });

  it("carries the scanned invoice number as the server's duplicate key", () => {
    expect(
      buildBillDtoFromScan(scanResult({ invoiceNumber: " INV-100 " }), suppliers),
    ).toHaveProperty("supplierInvoiceNumber", "INV-100");
  });

  it("keeps the legacy notes carrier the server parses, with the number as the last token", () => {
    const { notes } = buildBillDtoFromScan(scanResult(), suppliers);
    expect(notes).toContain("Supplier invoice #INV-100");
    // The server's fallback regex — clients that only send notes must still match.
    expect(notes?.match(/supplier invoice #\s*(\S+)/i)?.[1]).toBe("INV-100");
  });

  it("omits the number and its notes fragment when the scan found none", () => {
    const dto = buildBillDtoFromScan(scanResult({ invoiceNumber: null }), suppliers);
    expect(dto.supplierInvoiceNumber).toBeUndefined();
    expect(dto.notes).toBe("AI scanned from Metro Wholesale");
  });

  it("has no notes at all when neither supplier nor invoice number was read", () => {
    const dto = buildBillDtoFromScan(
      scanResult({ supplier: null, invoiceNumber: null }),
      suppliers,
    );
    expect(dto.notes).toBeUndefined();
    expect(dto.supplierInvoiceNumber).toBeUndefined();
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
    expect(dto.notes).toBe("Supplier invoice #INV-100");
    expect(dto.billDate).toBe("2026-07-01");
  });

  it("omits billDate when the scan has no invoiceDate", () => {
    const dto = buildBillDtoFromScan(scanResult({ invoiceDate: null }), suppliers);
    expect(dto.billDate).toBeUndefined();
  });
});

describe("scanBillTotal", () => {
  it("matches what the server computes as totalOwed — line sum PLUS the printed tax", () => {
    // 2×20 + 5×10 = 90 of goods, and the invoice's own $10 of tax is owed too.
    expect(scanBillTotal(buildBillDtoFromScan(scanResult(), suppliers))).toBe(100);
  });

  it("is the line sum alone when the invoice printed no tax", () => {
    expect(scanBillTotal(buildBillDtoFromScan(scanResult({ tax: null }), suppliers))).toBe(90);
  });

  it("rounds to cents", () => {
    const dto = buildBillDtoFromScan(
      scanResult({
        tax: null,
        items: [
          {
            extractedName: "Odd lot",
            qty: 3,
            unitCost: 0.335,
            lineTotal: null,
            matchedProductId: null,
            matchedProductName: null,
            confidence: "none",
          },
        ],
      }),
      suppliers,
    );
    expect(scanBillTotal(dto)).toBe(1.01);
  });
});

describe("duplicateBillPrompt", () => {
  const duplicate = (
    overrides: Partial<DuplicateVendorBillInfo> = {},
  ): DuplicateVendorBillInfo => ({
    billId: "bill-1",
    billNumber: "VB-0007",
    status: "DRAFT",
    resumable: true,
    totalOwed: 90,
    billDate: "2026-07-01",
    receivedDate: null,
    supplierName: "Metro Wholesale",
    itemCount: 2,
    matchedBy: "number",
    totalMatches: true,
    ...overrides,
  });

  it("nudges the operator to finish a resumable draft", () => {
    const { message, destructive } = duplicateBillPrompt(duplicate());
    expect(message).toContain("Metro Wholesale bill VB-0007");
    expect(message).toContain("$90.00");
    expect(message).toContain("open it to finish");
    expect(destructive).toBe(false);
  });

  it("warns about double-counting once the bill is past DRAFT", () => {
    const { message, destructive } = duplicateBillPrompt(
      duplicate({ status: "RECEIVED", resumable: false }),
    );
    expect(message).toContain("would double stock");
    expect(destructive).toBe(true);
  });

  it("falls back to the bill number when the supplier is unknown", () => {
    expect(duplicateBillPrompt(duplicate({ supplierName: null })).message).toContain(
      "Bill VB-0007",
    );
  });
});

describe("priorScanPrompt", () => {
  const prior = (overrides: Partial<PriorScanSummary> = {}): PriorScanSummary => ({
    scanId: "scan-1",
    scannedAt: "2026-07-03T12:00:00.000Z",
    status: "SCANNED",
    vendorBillId: null,
    billNumber: null,
    supplierInvoiceNumber: "INV-100",
    total: 100,
    ...overrides,
  });

  it("offers the bill when the earlier scan was already posted", () => {
    const p = priorScanPrompt(
      prior({ status: "POSTED", vendorBillId: "bill-1", billNumber: "BILL-2026-0007" }),
    );
    expect(p.title).toBe("You already scanned this");
    expect(p.message).toContain("BILL-2026-0007");
    expect(p.message).toContain("$100.00");
    expect(p.message).toContain("double stock");
    expect(p.billId).toBe("bill-1");
    expect(p.billLabel).toBe("Open BILL-2026-0007");
  });

  it("frames an unfinished review as restored work, with nothing to open", () => {
    const p = priorScanPrompt(prior());
    expect(p.title).toBe("Picking up where you left off");
    expect(p.message).toContain("never finished");
    expect(p.message).toContain("wasn't re-read");
    expect(p.billId).toBeNull();
  });

  it("has nothing to open when a POSTED scan lost its bill", () => {
    const p = priorScanPrompt(prior({ status: "POSTED", vendorBillId: null }));
    expect(p.billId).toBeNull();
    expect(p.title).toBe("Picking up where you left off");
  });

  it("drops the date clause rather than printing an unreadable one", () => {
    const { message } = priorScanPrompt(prior({ scannedAt: "not-a-date" }));
    expect(message).toContain("You scanned this invoice before and never finished");
    expect(message).not.toContain("Invalid Date");
  });
});

describe("mappingsFromScan", () => {
  // Only OPERATOR-confirmed links are taught back (`linkScanItem` sets
  // `operatorConfirmed`) — a line the AI auto-matched on its own is never
  // learned, or the matcher would train on its own guesses.
  it("returns one mapping per operator-confirmed line, keyed by the scanned supplier name", () => {
    const confirmed = linkScanItem(scanResult(), 0, "prod-1", "Cola 24 Pack");
    expect(mappingsFromScan(confirmed)).toEqual([
      { supplierName: "Metro Wholesale", rawDescription: "Cola 24pk", productId: "prod-1" },
    ]);
  });

  it("returns nothing without a supplier name (server mapping key)", () => {
    const confirmed = linkScanItem(scanResult({ supplier: "  " }), 0, "prod-1", "Cola 24 Pack");
    expect(mappingsFromScan(confirmed)).toEqual([]);
  });

  it("skips lines the AI matched but the operator never confirmed", () => {
    expect(mappingsFromScan(scanResult())).toEqual([]);
  });
});

describe("unmatchedCount", () => {
  it("counts lines with no product link (the ones that won't restock)", () => {
    // Fixture: 1 matched (Cola) + 1 unmatched (Mystery Snack).
    expect(unmatchedCount(scanResult())).toBe(1);
  });

  it("is zero once every line is linked", () => {
    const result = scanResult();
    result.items[1].matchedProductId = "prod-2";
    expect(unmatchedCount(result)).toBe(0);
  });

  it("ignores blank AI rows (no qty and no cost)", () => {
    const result = scanResult();
    result.items[1] = { extractedName: "junk", qty: 0, unitCost: 0, confidence: "none" };
    expect(unmatchedCount(result)).toBe(0);
  });

  it("counts a candidates-bearing unmatched line and keeps it out of the bill DTO's productId", () => {
    const result = scanResult();
    result.items[1] = {
      extractedName: "Big Red Cinnamon Gum",
      qty: 3,
      unitCost: 5,
      lineTotal: 15,
      matchedProductId: null,
      matchedProductName: null,
      confidence: "low",
      candidates: [
        {
          productId: "prod-variant",
          name: "Big Red Chewing Gum - Cinnamon",
          sku: null,
          score: 0.55,
        },
        { productId: "prod-standalone", name: "Big Red Chewing Gum", sku: null, score: 0.48 },
      ],
    };
    expect(unmatchedCount(result)).toBe(1);
    expect(buildBillDtoFromScan(result, suppliers).items[1].productId).toBeUndefined();
  });
});

describe("linkScanItem", () => {
  it("links the chosen line, promotes its confidence, and leaves others untouched", () => {
    const before = scanResult();
    const after = linkScanItem(before, 1, "prod-new", "Snack Box 12ct");
    expect(after.items[1].matchedProductId).toBe("prod-new");
    expect(after.items[1].matchedProductName).toBe("Snack Box 12ct");
    expect(after.items[1].confidence).toBe("high");
    // Line 0 unchanged; original object not mutated.
    expect(after.items[0]).toEqual(before.items[0]);
    expect(before.items[1].matchedProductId).toBeNull();
    // A linked line now flows into the bill DTO with its productId + drops the
    // unmatched count to zero, so it will restock on receive.
    expect(unmatchedCount(after)).toBe(0);
    expect(buildBillDtoFromScan(after, suppliers).items[1].productId).toBe("prod-new");
  });
});
