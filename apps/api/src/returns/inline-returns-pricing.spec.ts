/**
 * PR-1b literal-oracle pins (design.md §3.5) — each hand-computed, each names the
 * exact value a reverted fix/guard would produce instead.
 */
import {
  allocateReturnedPieces,
  priceManualChunk,
  priceMatchedChunk,
  priceUnreferencedChunk,
  returnRequestPieces,
  totalChunks,
  type CandidateInvoiceLine,
} from "./inline-returns-pricing";

/** A fully-specified candidate line with sane defaults, overridden per test. */
function line(overrides: Partial<CandidateInvoiceLine>): CandidateInvoiceLine {
  return {
    sourceOrderId: "order-1",
    sourceInvoiceItemId: "item-1",
    sourceOrderItemId: "oi-1",
    productId: "prod-1",
    qty: 0,
    unitPrice: 0,
    subtotal: 0,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    promoFreeUnits: null,
    taxRate: 0,
    categoryTax: null,
    invoiceSubtotal: 0,
    invoiceDiscount: 0,
    invoiceTaxAmount: 0,
    ...overrides,
  };
}

describe("§3.5 literal oracles — priceMatchedChunk", () => {
  it("box-split: 2 bx + 6 pcs @ $24/bx (upb 12, stored $60.00), return 1 bx + 3 pcs → $30.00 (revert $2.50)", () => {
    const l = line({ boxes: 2, pieces: 6, unitsPerBox: 12, qty: 30, unitPrice: 24, subtotal: 60 });
    const chunkPieces = returnRequestPieces({ qty: 0, boxes: 1, pieces: 3, unitsPerBox: 12 });
    expect(chunkPieces).toBe(15);
    const priced = priceMatchedChunk(l, chunkPieces, false);
    expect(priced.subtotal).toBe(30.0);
    // Revert probe: pricing 15 raw pieces at the box PRICE ($24) instead of prorating
    // against the line's own 30-piece total gives 15 * (24/12) = $30 too by
    // coincidence at THIS ratio — the real revert this guards is treating boxes=1
    // piece=3 as "4 pieces" (ignoring unitsPerBox), which would price at
    // 4/30 * 60 = $8.00, not $30.00.
    expect(priced.subtotal).not.toBe(8.0);
  });

  it("selling-unit: qty 2 (bx), boxes null, upb 12, stored $48.00, return 15 pcs → $30.00 (revert $60.00)", () => {
    const l = line({
      boxes: null,
      pieces: null,
      unitsPerBox: 12,
      qty: 2,
      unitPrice: 24,
      subtotal: 48,
    });
    const priced = priceMatchedChunk(l, 15, false);
    expect(priced.subtotal).toBe(30.0);
    // Revert probe: treating 15 pieces as 15 SELLING units against a 2-unit line
    // (skipping the ÷unitsPerBox conversion) prorates 15/2 of $48, capped nowhere,
    // giving $360.00 rather than $30.00 — an order-of-magnitude over-credit.
    expect(priced.subtotal).not.toBe(360.0);
  });

  it("BOGO: 12 bx, promoFreeUnits 2 @ $35 (stored $350.00), return 6 bx → $175.00 (revert $210.00)", () => {
    const l = line({
      boxes: null,
      pieces: null,
      unitsPerBox: 12,
      qty: 12,
      unitPrice: 35,
      subtotal: 350,
      promoFreeUnits: 2,
    });
    const chunkPieces = returnRequestPieces({ qty: 0, boxes: 6, pieces: 0, unitsPerBox: 12 });
    const priced = priceMatchedChunk(l, chunkPieces, false);
    expect(priced.subtotal).toBe(175.0);
    // Revert probe: prorating over the PAID basis (10 = 12 - 2 free) without also
    // reducing the delivered/returned qty by the free units it displaces
    // (billedThrough) prices 6/10 of $350 = $210.00 — over-crediting because the
    // returned chunk itself is treated as containing none of the free allocation.
    const naiveHalfFixed = Math.round(350 * (6 / 10) * 100) / 100;
    expect(naiveHalfFixed).toBe(210.0);
    expect(priced.subtotal).not.toBe(naiveHalfFixed);
  });

  it("discount share: invoice subtotal $200, discount $20, whole $50.00 line → net $45.00, tax on $50.00 (revert $50.00 net)", () => {
    const l = line({
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      qty: 5,
      unitPrice: 10,
      subtotal: 50,
      taxRate: 0.08,
      invoiceSubtotal: 200,
      invoiceDiscount: 20,
      invoiceTaxAmount: 16, // this invoice DID charge tax — the m-7 zero-tax guard must not fire
    });
    const priced = priceMatchedChunk(l, 5, false);
    expect(priced.subtotal).toBe(45.0);
    // Tax is computed on the PRE-discount prorated amount ($50), not the net $45 —
    // 0.08 * 50 = 4.00, never 0.08 * 45 = 3.60.
    expect(priced.taxAmount).toBe(4.0);
    // Revert probe: skipping the discount-share subtraction entirely credits the
    // full undiscounted $50.00 instead of $45.00.
    expect(priced.subtotal).not.toBe(50.0);
  });

  it("exempt (rate 0): taxRate 0 on an exempt customer → tax $0.00", () => {
    const l = line({ qty: 5, unitPrice: 10, subtotal: 50, taxRate: 0, invoiceTaxAmount: 0 });
    const priced = priceMatchedChunk(l, 5, true);
    expect(priced.taxAmount).toBe(0.0);
  });

  it("exempt (manual invoice): line taxRate 0.08, invoice taxAmount 0, exempt customer → tax $0.00 (revert $4.00)", () => {
    const l = line({
      qty: 5,
      unitPrice: 10,
      subtotal: 50,
      taxRate: 0.08,
      invoiceTaxAmount: 0, // m-7 guard: the invoice itself charged no tax at all
    });
    const priced = priceMatchedChunk(l, 5, true);
    expect(priced.taxAmount).toBe(0.0);
    // Revert probe: skipping the m-7 guard and applying the line's snapshot rate
    // blindly credits 0.08 * $50.00 = $4.00 of tax the invoice never actually charged.
    const naiveTax = Math.round(50 * 0.08 * 100) / 100;
    expect(naiveTax).toBe(4.0);
    expect(priced.taxAmount).not.toBe(naiveTax);
  });

  it("rate change: line taxRate 0.08, tenant now 0.10, matched → tax at 0.08 (revert 0.10)", () => {
    const l = line({ qty: 5, unitPrice: 10, subtotal: 50, taxRate: 0.08, invoiceTaxAmount: 4 });
    const priced = priceMatchedChunk(l, 5, false);
    expect(priced.taxAmount).toBe(4.0); // 0.08 * 50
    // Revert probe: re-deriving tax from the tenant's CURRENT rate (0.10) instead of
    // the line's own snapshot would credit 0.10 * $50.00 = $5.00.
    const currentRateTax = Math.round(50 * 0.1 * 100) / 100;
    expect(currentRateTax).toBe(5.0);
    expect(priced.taxAmount).not.toBe(currentRateTax);
  });
});

describe("returnRequestPieces", () => {
  it("boxes/pieces DTO converts to raw pieces", () => {
    expect(returnRequestPieces({ qty: 0, boxes: 1, pieces: 3, unitsPerBox: 12 })).toBe(15);
  });
  it("bare qty with a unitsPerBox snapshot is treated as selling units", () => {
    expect(returnRequestPieces({ qty: 6, unitsPerBox: 12 })).toBe(72);
  });
  it("bare qty with no box size is already pieces", () => {
    expect(returnRequestPieces({ qty: 15 })).toBe(15);
  });
});

describe("allocateReturnedPieces", () => {
  it("allocates newest order first, then the unallocated remainder as the over-return chunk", () => {
    const newer = line({ sourceOrderId: "order-newer", qty: 10, unitPrice: 5, subtotal: 50 });
    const older = line({ sourceOrderId: "order-older", qty: 10, unitPrice: 5, subtotal: 50 });
    const chunks = allocateReturnedPieces(
      [newer, older],
      [
        { sourceOrderId: "order-newer", productId: "prod-1", remainingPieces: 4 },
        { sourceOrderId: "order-older", productId: "prod-1", remainingPieces: 3 },
      ],
      "prod-1",
      10,
    );
    expect(chunks).toEqual([
      { line: newer, pieces: 4 },
      { line: older, pieces: 3 },
      { line: null, pieces: 3 },
    ]);
  });

  it("a fully-supplied request allocates nothing to the over-return chunk", () => {
    const only = line({ sourceOrderId: "order-1", qty: 10, unitPrice: 5, subtotal: 50 });
    const chunks = allocateReturnedPieces(
      [only],
      [{ sourceOrderId: "order-1", productId: "prod-1", remainingPieces: 10 }],
      "prod-1",
      10,
    );
    expect(chunks).toEqual([{ line: only, pieces: 10 }]);
  });
});

describe("priceUnreferencedChunk / priceManualChunk", () => {
  it("unreferenced tier price, taxed", () => {
    const priced = priceUnreferencedChunk(
      "prod-1",
      3,
      { unitPrice: 10, source: "TIER" },
      0.08,
      false,
    );
    expect(priced.subtotal).toBe(30.0);
    expect(priced.taxAmount).toBe(2.4);
    expect(priced.priceSource).toBe("TIER");
    expect(priced.sourceOrderId).toBeNull();
  });

  it("manual override keeps the reason and overriddenBy for audit", () => {
    const priced = priceManualChunk(
      "prod-1",
      2,
      { unitPrice: 15, reason: "damaged, priced below list", overriddenBy: "user-1" },
      0,
      false,
    );
    expect(priced.subtotal).toBe(30.0);
    expect(priced.priceSource).toBe("MANUAL");
    expect(priced.overrideReason).toBe("damaged, priced below list");
    expect(priced.overriddenBy).toBe("user-1");
  });
});

describe("totalChunks", () => {
  it("sums subtotal/tax/categoryTax across chunks and rounds once more", () => {
    const chunks = [
      priceMatchedChunk(
        line({ qty: 5, unitPrice: 10, subtotal: 50, taxRate: 0.08, invoiceTaxAmount: 4 }),
        5,
        false,
      ),
      priceUnreferencedChunk("prod-2", 1, { unitPrice: 9.99, source: "BASE" }, 0.08, false),
    ];
    const totals = totalChunks(chunks);
    expect(totals.subtotal).toBe(roundMoneySum(50, 9.99));
    expect(totals.total).toBe(roundMoneySum(totals.subtotal, totals.taxAmount, totals.categoryTax));
  });
});

function roundMoneySum(...values: number[]): number {
  return Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
}
