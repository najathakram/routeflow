import {
  applyLineEdit,
  buildBillDtoFromScan,
  initialPpbDraft,
  linkScanItem,
  mappingsFromScan,
  pieceSnapshotFromLine,
  unitFromLine,
  type ScanResultEx,
  type SupplierRef,
} from "../lib/vendor-bill-scan";
import { roundMoney } from "@routeflow/pricing";

/**
 * PR-5 additions to the scan-review pure logic: confirm-only learning
 * (`operatorConfirmed`), server-resolved `supplierId` preference, and the
 * Boxes/Pieces line editor (`applyLineEdit`, delegating to
 * `scan-line-units.ts#toBillLine`). `packSize` is the money-critical field —
 * `lineInventoryDelta` on the API converts a bill line at receive ONLY when
 * `packSize > 1`, so a Boxes line saved without it books 1 piece at the case
 * price instead of piecesPerBox pieces at the per-piece price (#335/#336).
 */

const suppliers: SupplierRef[] = [
  { id: "sup-1", name: "Metro Wholesale" },
  { id: "sup-2", name: "Cash & Carry" },
];

function scanResult(overrides: Partial<ScanResultEx> = {}): ScanResultEx {
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

describe("linkScanItem", () => {
  it("marks the line operator-confirmed alongside the existing link/promote behavior", () => {
    const before = scanResult();
    const after = linkScanItem(before, 1, "prod-new", "Snack Box 12ct");
    expect(after.items[1].matchedProductId).toBe("prod-new");
    expect(after.items[1].confidence).toBe("high");
    expect(after.items[1].operatorConfirmed).toBe(true);
    // A line the AI auto-matched (never touched by linkScanItem) stays unconfirmed.
    expect(after.items[0].operatorConfirmed).toBeUndefined();
  });
});

describe("mappingsFromScan — confirm-only learning", () => {
  it("teaches nothing for a line the AI auto-matched but the operator never confirmed", () => {
    // item[0] arrives pre-matched straight off the scan — never routed through
    // linkScanItem — so it must NOT be taught back, or the app would learn
    // from its own unconfirmed guesses.
    expect(mappingsFromScan(scanResult())).toEqual([]);
  });

  it("teaches the line the operator explicitly linked", () => {
    const confirmed = linkScanItem(scanResult(), 1, "prod-9", "Snack Box 12ct");
    expect(mappingsFromScan(confirmed)).toEqual([
      { supplierName: "Metro Wholesale", rawDescription: "Mystery Snack", productId: "prod-9" },
    ]);
  });

  it("still requires a supplier name even for a confirmed link", () => {
    const confirmed = linkScanItem(scanResult({ supplier: "  " }), 1, "prod-9", "Snack Box 12ct");
    expect(mappingsFromScan(confirmed)).toEqual([]);
  });
});

describe("buildBillDtoFromScan — server-resolved supplierId", () => {
  it("prefers the server-resolved supplierId over the client-side name match", () => {
    // Local match would resolve "Metro Wholesale" -> sup-1; the server says sup-2.
    const dto = buildBillDtoFromScan(scanResult({ supplierId: "sup-2" }), suppliers);
    expect(dto.supplierId).toBe("sup-2");
  });

  it("falls back to the client-side name match when the scan carries no supplierId", () => {
    const dto = buildBillDtoFromScan(scanResult(), suppliers);
    expect(dto.supplierId).toBe("sup-1");
  });

  it("falls back cleanly when neither the server nor the local list resolves anything", () => {
    const dto = buildBillDtoFromScan(
      scanResult({ supplierId: null, supplier: "Unknown Co" }),
      suppliers,
    );
    expect(dto.supplierId).toBeUndefined();
  });
});

describe("pieceSnapshotFromLine", () => {
  it("canonicalizes a boxed line into per-piece terms", () => {
    // 1 case @ $30, 24/box -> 24 pieces @ $1.25.
    expect(pieceSnapshotFromLine({ qty: 1, unitCost: 30, packSize: 24 })).toEqual({
      qtyPieces: 24,
      costPerPiece: 1.25,
    });
  });

  it("leaves a pieces line as-is", () => {
    expect(pieceSnapshotFromLine({ qty: 24, unitCost: 1.25, packSize: null })).toEqual({
      qtyPieces: 24,
      costPerPiece: 1.25,
    });
  });

  it("treats packSize <= 1 the same as unboxed", () => {
    expect(pieceSnapshotFromLine({ qty: 5, unitCost: 2, packSize: 1 })).toEqual({
      qtyPieces: 5,
      costPerPiece: 2,
    });
  });

  it("keeps a case cost that doesn't divide evenly at full precision, so reopening the sheet can't drift it", () => {
    // $19.99 / 24 is 0.83291666… — rounding it into the snapshot would render
    // (and save) the case back as $19.9896 the moment the sheet opened.
    const line = { qty: 1, unitCost: 19.99, packSize: 24 };
    const snap = pieceSnapshotFromLine(line);
    const reopened = applyLineEdit(scanResult(), 0, snap, "boxes", 24, null).items[0];
    expect(reopened.qty).toBe(1);
    expect(reopened.unitCost).toBe(19.99);
  });
});

describe("unitFromLine", () => {
  it("derives boxes only from packSize > 1", () => {
    expect(unitFromLine({ packSize: 24 })).toBe("boxes");
    expect(unitFromLine({ packSize: 1 })).toBe("pieces");
    expect(unitFromLine({ packSize: null })).toBe("pieces");
    expect(unitFromLine({})).toBe("pieces");
  });
});

describe("initialPpbDraft", () => {
  it("prefers the OCR-read packSize over the catalog product", () => {
    expect(initialPpbDraft({ packSize: 12 }, 24)).toBe(12);
  });

  it("falls back to the catalog product's unitsPerBox when OCR gave none", () => {
    expect(initialPpbDraft({ packSize: null }, 24)).toBe(24);
  });

  it("is null when neither source has a real box size", () => {
    expect(initialPpbDraft({ packSize: null }, null)).toBeNull();
    expect(initialPpbDraft({ packSize: 1 }, 1)).toBeNull();
  });
});

describe("applyLineEdit — the A3 contract (packSize always explicit)", () => {
  it("a Pieces choice always writes packSize: null — never leaves a stale OCR value", () => {
    // The scanned line printed as 1 case @ $30, packSize 24 — canonicalizes to {24, 1.25}.
    const scannedAsCase = {
      extractedName: "Cola 24pk",
      qty: 1,
      unitCost: 30,
      packSize: 24,
      confidence: "high" as const,
    };
    const before = scanResult({ items: [scannedAsCase, scanResult().items[1]] });
    const snap = pieceSnapshotFromLine(scannedAsCase);
    const after = applyLineEdit(before, 0, snap, "pieces", 24, null);
    expect(after.items[0].packSize).toBeNull();
    expect(after.items[0].qty).toBe(24);
    expect(after.items[0].unitCost).toBe(1.25);
    expect(after.items[0].warning).toBeUndefined();
  });

  it("a Boxes choice writes the on-screen piecesPerBox as packSize, never omitted", () => {
    // The scanned line printed as 24 pcs @ $1.25, no packSize at all.
    const scannedAsPieces = {
      extractedName: "Cola 24pk",
      qty: 24,
      unitCost: 1.25,
      packSize: null,
      confidence: "high" as const,
    };
    const before = scanResult({ items: [scannedAsPieces, scanResult().items[1]] });
    const snap = pieceSnapshotFromLine(scannedAsPieces);
    const after = applyLineEdit(before, 0, snap, "boxes", 24, null);
    expect(after.items[0].packSize).toBe(24);
    expect(after.items[0].qty).toBe(1);
    expect(after.items[0].unitCost).toBe(30);
  });

  it("the line total is identical across both representations of the same snapshot", () => {
    const snap = { qtyPieces: 24, costPerPiece: 1.25 };
    const pieces = applyLineEdit(scanResult(), 0, snap, "pieces", 24, null).items[0];
    const boxes = applyLineEdit(scanResult(), 0, snap, "boxes", 24, null).items[0];
    expect(roundMoney(pieces.qty! * pieces.unitCost!)).toBe(
      roundMoney(boxes.qty! * boxes.unitCost!),
    );
    expect(roundMoney(pieces.qty! * pieces.unitCost!)).toBe(30);
  });

  it("a non-divisible piece count falls back to pieces with NOT_DIVISIBLE and a null packSize", () => {
    const snap = { qtyPieces: 25, costPerPiece: 1 };
    const after = applyLineEdit(scanResult(), 0, snap, "boxes", 24, null).items[0];
    expect(after.warning).toBe("NOT_DIVISIBLE");
    expect(after.packSize).toBeNull();
    expect(after.qty).toBe(25);
  });

  it("flags PPB_MISMATCH but still saves the on-screen piecesPerBox, not the catalog's", () => {
    const snap = { qtyPieces: 24, costPerPiece: 1.25 };
    const after = applyLineEdit(scanResult(), 0, snap, "boxes", 24, 12).items[0];
    expect(after.warning).toBe("PPB_MISMATCH");
    expect(after.packSize).toBe(24);
  });

  it("clears a stale warning once the new conversion is clean", () => {
    const dirty = applyLineEdit(
      scanResult(),
      0,
      { qtyPieces: 25, costPerPiece: 1 },
      "boxes",
      24,
      null,
    );
    expect(dirty.items[0].warning).toBe("NOT_DIVISIBLE");
    const cleaned = applyLineEdit(dirty, 0, { qtyPieces: 24, costPerPiece: 1 }, "boxes", 24, null);
    expect(cleaned.items[0].warning).toBeUndefined();
  });

  it("round-trips losslessly: pieces -> boxes -> pieces restores the original snapshot", () => {
    const original = { qtyPieces: 24, costPerPiece: 1.25 };
    const asBoxes = applyLineEdit(scanResult(), 0, original, "boxes", 24, null).items[0];
    // Re-seed the sheet's baseline exactly as LineEditSheet would on reopen.
    const reseeded = pieceSnapshotFromLine({
      qty: asBoxes.qty!,
      unitCost: asBoxes.unitCost!,
      packSize: asBoxes.packSize,
    });
    const backToPieces = applyLineEdit(scanResult(), 0, reseeded, "pieces", 24, null).items[0];
    expect(backToPieces.qty).toBe(original.qtyPieces);
    expect(backToPieces.unitCost).toBe(original.costPerPiece);
  });

  it("leaves every other line and header field untouched", () => {
    const before = scanResult();
    const after = applyLineEdit(
      before,
      0,
      { qtyPieces: 24, costPerPiece: 1.25 },
      "boxes",
      24,
      null,
    );
    expect(after.items[1]).toEqual(before.items[1]);
    expect(after.supplier).toBe(before.supplier);
  });
});
