/**
 * PR-1b literal-oracle pins (design.md §3.5) — each hand-computed, each names the
 * exact value a reverted fix/guard would produce instead.
 */
import {
  allocateReturnedPieces,
  applyCreditOverride,
  CREDIT_OVERRIDE_EQUAL_TOLERANCE,
  priceMatchedChunk,
  priceUnreferencedChunk,
  resolveReturnPackFactor,
  returnRequestPieces,
  totalChunks,
  type CandidateInvoiceLine,
} from "./inline-returns-pricing";

/** A fully-specified candidate line with sane defaults, overridden per test. `piecesQty`
 * auto-derives from qty/boxes/unitsPerBox (the same rule the real caller uses) unless the
 * override supplies it explicitly. */
function line(overrides: Partial<CandidateInvoiceLine>): CandidateInvoiceLine {
  const base = {
    sourceOrderId: "order-1",
    sourceInvoiceItemId: "item-1",
    sourceOrderItemId: "oi-1",
    productId: "prod-1",
    qty: 0,
    unitPrice: 0,
    subtotal: 0,
    boxes: null as number | null,
    pieces: null as number | null,
    unitsPerBox: null as number | null,
    promoFreeUnits: null,
    taxRate: 0,
    categoryTax: null,
    invoiceSubtotal: 0,
    invoiceDiscount: 0,
    invoiceTaxAmount: 0,
    ...overrides,
  };
  const piecesQty =
    overrides.piecesQty ?? (base.boxes != null ? base.qty : base.qty * (base.unitsPerBox || 1));
  return { ...base, piecesQty };
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

describe("resolveReturnPackFactor — SA-101(2)/B3/B765 interim guard", () => {
  it("a single candidate pack is used — the sound case, no conflict", () => {
    expect(resolveReturnPackFactor([12], null)).toEqual({ factor: 12, conflictingPacks: null });
  });

  it("packs 12 and 4 disagree — reports the conflict, ascending, no usable factor", () => {
    expect(resolveReturnPackFactor([12, 4], null)).toEqual({
      factor: null,
      conflictingPacks: [4, 12],
    });
  });

  it("the same pack repeated across multiple lines is NOT a conflict", () => {
    expect(resolveReturnPackFactor([12, 12, 12], null)).toEqual({
      factor: 12,
      conflictingPacks: null,
    });
  });

  it("no candidate lines at all falls back to the product's own unitsPerBox", () => {
    expect(resolveReturnPackFactor([], 6)).toEqual({ factor: 6, conflictingPacks: null });
  });

  it("no candidates AND no product unitsPerBox: a null factor — the caller must refuse before using it as a boxed multiplier", () => {
    expect(resolveReturnPackFactor([], null)).toEqual({ factor: null, conflictingPacks: null });
  });

  it("null/undefined/zero entries among the candidates are ignored, not counted as a distinct pack", () => {
    expect(resolveReturnPackFactor([null, undefined, 0, 12], null)).toEqual({
      factor: 12,
      conflictingPacks: null,
    });
  });

  // SA-108 (R-029): a pack of exactly 1 means "no packaging" — the same convention
  // isBoxedProduct/ResolveParkedRestockDto use — never a competing distinct pack claim.
  it("a pack of 1 is ignored too, exactly like null/undefined/zero — never a distinct pack", () => {
    expect(resolveReturnPackFactor([1, 1, 1], null)).toEqual({
      factor: null,
      conflictingPacks: null,
    });
  });

  it("packs 1 and 12 do NOT conflict — 1 means no packaging, 12 wins as the real pack", () => {
    expect(resolveReturnPackFactor([1, 12], null)).toEqual({ factor: 12, conflictingPacks: null });
  });

  it("packs 1 and 12 and 4 STILL conflict on the two real packs — the 1 just drops out", () => {
    expect(resolveReturnPackFactor([1, 12, 4], null)).toEqual({
      factor: null,
      conflictingPacks: [4, 12],
    });
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

  it("Opus fix-round BLOCKER: caps on piecesQty, never a selling-unit line's own qty (revert: caps at 2 instead of 24)", () => {
    // qty 2 (boxes, selling-unit line, boxes:null), upb 12 -> piecesQty 24.
    const sellingUnit = line({
      sourceOrderId: "order-1",
      qty: 2,
      unitsPerBox: 12,
      unitPrice: 24,
      subtotal: 48,
    });
    expect(sellingUnit.piecesQty).toBe(24);
    const chunks = allocateReturnedPieces(
      [sellingUnit],
      [{ sourceOrderId: "order-1", productId: "prod-1", remainingPieces: 24 }],
      "prod-1",
      15,
    );
    // Revert probe: capping on line.qty (2) instead of piecesQty (24) would only allocate 2
    // pieces to this line and dump the other 13 into the unreferenced over-return chunk.
    expect(chunks).toEqual([{ line: sellingUnit, pieces: 15 }]);
  });
});

describe("priceUnreferencedChunk", () => {
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

  it("Opus fix-round BLOCKER: a boxed unreferenced return prices via the SELLING-UNIT (box) rate, never unitPrice x pieces (revert $288.00)", () => {
    // upb 12, $24/box, returning exactly 1 box (12 pieces).
    const priced = priceUnreferencedChunk(
      "prod-1",
      12,
      { unitPrice: 24, source: "TIER", unitsPerBox: 12 },
      0,
      false,
    );
    expect(priced.subtotal).toBe(24.0);
    // Revert probe: `roundMoney(unitPrice * chunkPieces)` treats the box price as a per-piece
    // rate, crediting 24 * 12 = $288.00 for what should be exactly one box.
    expect(priced.subtotal).not.toBe(288.0);
  });
});

describe("applyCreditOverride (#2695, SA-557: lower-only staff credit price)", () => {
  const WHO = { reason: "damaged in transit", overriddenBy: "user-op-1" };
  // A matched chunk: 4 pieces of a $10/piece line, 8% snapshot, $1.20 excise carried.
  const matched = priceMatchedChunk(
    line({
      qty: 10,
      unitPrice: 10,
      subtotal: 100,
      taxRate: 0.08,
      invoiceTaxAmount: 8,
      categoryTax: 3,
    }),
    4,
    false,
  );
  const matchedBasis = { unitsPerBox: null, taxRate: 0.08, taxExempt: false };

  it("fixture sanity: the default matched chunk is $40.00 / $3.20 tax / $1.20 excise", () => {
    expect([matched.subtotal, matched.taxAmount, matched.categoryTax]).toEqual([40, 3.2, 1.2]);
  });

  it("an override EQUAL to the default (within the tolerance) is not an override: the default chunk untouched", () => {
    for (const p of [
      10,
      10 + CREDIT_OVERRIDE_EQUAL_TOLERANCE,
      10 - CREDIT_OVERRIDE_EQUAL_TOLERANCE,
    ]) {
      const r = applyCreditOverride(matched, { unitPrice: p, ...WHO }, matchedBasis);
      expect(r).toEqual({ overCap: false, chunk: matched });
      if (!r.overCap) expect(r.chunk).toBe(matched); // same object: no MANUAL, no audit fields
    }
  });

  it("an override BELOW the default rescales subtotal and tax, carries excise and source ids, and records the default replaced", () => {
    const r = applyCreditOverride(matched, { unitPrice: 7.5, ...WHO }, matchedBasis);
    expect(r.overCap).toBe(false);
    if (r.overCap) return;
    expect(r.chunk).toEqual({
      ...matched,
      subtotal: 30, // 4 x $7.50 (revert: $40.00)
      taxAmount: 2.4, // $30 x 8% snapshot (revert: $3.20)
      categoryTax: 1.2, // CARRIED (revert of the old manual path: $0.00)
      priceSource: "MANUAL",
      unitPrice: 7.5,
      originalPrice: 10, // the DEFAULT replaced (the old manual path stored the override: 7.5)
      overrideReason: "damaged in transit",
      overriddenBy: "user-op-1",
    });
    expect(r.chunk.sourceInvoiceItemId).toBe("item-1");
  });

  it("an override ABOVE the default is over the cap (no uncapped path)", () => {
    expect(applyCreditOverride(matched, { unitPrice: 10.01, ...WHO }, matchedBasis)).toEqual({
      overCap: true,
      defaultUnitPrice: 10,
    });
  });

  it("zero is a valid override (a no-credit return), still MANUAL and audited", () => {
    const r = applyCreditOverride(matched, { unitPrice: 0, ...WHO }, matchedBasis);
    expect(r.overCap).toBe(false);
    if (!r.overCap) {
      expect([r.chunk.subtotal, r.chunk.taxAmount, r.chunk.priceSource]).toEqual([0, 0, "MANUAL"]);
    }
  });

  it("a boxed chunk compares and prices per SELLING unit via computeLineSubtotal (1 box + 6 pieces at $18/box = $27.00, revert $324.00)", () => {
    const boxed = priceUnreferencedChunk(
      "prod-1",
      18,
      { unitPrice: 24, source: "TIER", unitsPerBox: 12 },
      0.05,
      false,
    );
    expect(boxed.subtotal).toBe(36); // 1.5 boxes at $24
    const r = applyCreditOverride(
      boxed,
      { unitPrice: 18, ...WHO },
      { unitsPerBox: 12, taxRate: 0.05, taxExempt: false },
    );
    expect(r.overCap).toBe(false);
    if (r.overCap) return;
    expect(r.chunk.subtotal).toBe(27);
    expect(r.chunk.subtotal).not.toBe(324);
    expect(r.chunk.taxAmount).toBe(1.35); // the replaced chunk's quote rate
    expect(r.chunk.originalPrice).toBe(24);
    // $24.50/box is above the $24 box default: over the cap even though it is < $36 total.
    expect(
      applyCreditOverride(
        boxed,
        { unitPrice: 24.5, ...WHO },
        { unitsPerBox: 12, taxRate: 0.05, taxExempt: false },
      ).overCap,
    ).toBe(true);
  });

  it("an exempt basis (a no-tax invoice, or an exempt customer) credits $0.00 tax on the override", () => {
    const r = applyCreditOverride(
      matched,
      { unitPrice: 5, ...WHO },
      { ...matchedBasis, taxExempt: true },
    );
    expect(r.overCap).toBe(false);
    if (!r.overCap) expect([r.chunk.subtotal, r.chunk.taxAmount]).toEqual([20, 0]);
  });

  it("a matched line's DISCOUNTED net price is the cap, not its list price", () => {
    // $100 line on a $100 invoice with a $20 discount: 4 pieces default to $32.00 ($8.00 net each).
    const net = priceMatchedChunk(
      line({ qty: 10, unitPrice: 10, subtotal: 100, invoiceSubtotal: 100, invoiceDiscount: 20 }),
      4,
      false,
    );
    expect(net.subtotal).toBe(32);
    const basis = { unitsPerBox: null, taxRate: 0, taxExempt: false };
    expect(applyCreditOverride(net, { unitPrice: 9, ...WHO }, basis)).toEqual({
      overCap: true,
      defaultUnitPrice: 8,
    });
    expect(applyCreditOverride(net, { unitPrice: 8, ...WHO }, basis)).toEqual({
      overCap: false,
      chunk: net,
    });
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
