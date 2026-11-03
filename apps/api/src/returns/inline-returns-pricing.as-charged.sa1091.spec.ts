/**
 * SA-1091 A-1: a matched inline-return chunk is priced as what the invoice CHARGED (`refundableLineShare`), so the lines of a
 * whole sale add up to the invoice exactly. An invoice rounds its tax once across all its lines; the old pricer rounded per
 * line and could come to a cent more than `Invoice.total`, which the order-wide bound then refused (the #4127 hold).
 *
 *   AC-3  $6.50 + $2.50 at 8.25% (invoice 9.74): 7.03 + 2.71, never 7.04 + 2.71 = 9.75
 *   AC-4  three $1.06 lines, $1.00 off, no tax (invoice 2.18): 0.72 + 0.73 + 0.73
 *   AC-5  $10 + $20 at 8.25% (invoice 32.48): unchanged, 10.83 + 21.65
 *   AC-6  a line already taken at the old price (7.04): the other line stops at what is left of each charge (2.70)
 *   AC-10 slices of one line add up: 3 then 4 of a 7-piece line
 *   AC-11 a levy (category tax) rides the helper: whole line, and a slice
 *   AC-12 a typed price below the default never takes more tax than the default chunk did
 *   AC-13 an invoice discount leaves the NSF fee line out of its denominator
 *   AC-14 a customer exempt now still gets no tax back
 *   AC-15 (see refund-slice-single-source.spec.ts) the inline pricer holds no slice math of its own
 */
import { NSF_FEE_SYSTEM_KIND, type RefundableInvoice } from "@routeflow/pricing";
import {
  applyCreditOverride,
  priceMatchedChunk,
  type CandidateInvoiceLine,
  type TakenAmounts,
} from "./inline-returns-pricing";

interface SeedLine {
  id: string;
  qty: number;
  subtotal: number;
  taxRate?: number;
  levy?: number;
}

function invoiceOf(
  lines: SeedLine[],
  taxAmount: number,
  discount = 0,
  extra: RefundableInvoice["lines"] = [],
): RefundableInvoice {
  return {
    taxAmount,
    discount,
    lines: [
      ...lines.map((l) => ({
        id: l.id,
        subtotal: l.subtotal,
        qty: l.qty,
        taxRate: l.taxRate ?? 0,
        categoryTaxAmount: l.levy ?? 0,
        isNsf: false,
      })),
      ...extra,
    ],
  };
}

/** The candidate line the quote builds for `id` on `invoice` (the whole invoice rides on it). */
function candidate(
  invoice: RefundableInvoice,
  id: string,
  o: Partial<CandidateInvoiceLine> = {},
): CandidateInvoiceLine {
  const l = invoice.lines.find((x) => x.id === id)!;
  const invoiceSubtotal = invoice.lines.reduce((t, x) => t + Number(x.subtotal), 0);
  const qty = Number(l.qty);
  return {
    sourceOrderId: "order-1",
    sourceInvoiceItemId: id,
    sourceOrderItemId: `oi-${id}`,
    productId: `prod-${id}`,
    qty,
    piecesQty: qty,
    unitPrice: Number(l.subtotal) / qty,
    subtotal: Number(l.subtotal),
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    promoFreeUnits: null,
    taxRate: Number(l.taxRate ?? 0),
    categoryTax: Number(l.categoryTaxAmount ?? 0) || null,
    invoiceSubtotal,
    invoiceDiscount: Number(invoice.discount),
    invoiceTaxAmount: Number(invoice.taxAmount),
    invoice,
    ...o,
  };
}

const gross = (c: { subtotal: number; taxAmount: number; categoryTax: number }) =>
  Math.round((c.subtotal + c.taxAmount + c.categoryTax) * 100) / 100;

describe("SA-1091 A-1: inline chunks priced as the invoice charged", () => {
  // $6.50 + $2.50 at 8.25%: tax rounded once on the invoice is 0.74, total 9.74
  const nine74 = invoiceOf(
    [
      { id: "l1", qty: 1, subtotal: 6.5, taxRate: 0.0825 },
      { id: "l2", qty: 1, subtotal: 2.5, taxRate: 0.0825 },
    ],
    0.74,
  );

  it("AC-3: the two lines of a whole sale price 7.03 and 2.71 and add up to the invoice's 9.74", () => {
    const a = priceMatchedChunk(candidate(nine74, "l1"), 1, false);
    const b = priceMatchedChunk(candidate(nine74, "l2"), 1, false);
    expect([gross(a), gross(b)]).toEqual([7.03, 2.71]);
    expect(Math.round((gross(a) + gross(b)) * 100) / 100).toBe(9.74);
  });

  it("AC-3: the order the lines come back in does not matter (line 2 first)", () => {
    const b = priceMatchedChunk(candidate(nine74, "l2"), 1, false);
    const a = priceMatchedChunk(candidate(nine74, "l1"), 1, false);
    expect(Math.round((gross(a) + gross(b)) * 100) / 100).toBe(9.74);
  });

  it("AC-4: three $1.06 lines with $1.00 off and no tax price 0.72 / 0.73 / 0.73 = 2.18", () => {
    const inv = invoiceOf(
      [
        { id: "a", qty: 1, subtotal: 1.06 },
        { id: "b", qty: 1, subtotal: 1.06 },
        { id: "c", qty: 1, subtotal: 1.06 },
      ],
      0,
      1,
    );
    const out = ["a", "b", "c"].map((id) => gross(priceMatchedChunk(candidate(inv, id), 1, false)));
    expect(out.slice().sort()).toEqual([0.72, 0.73, 0.73]);
    expect(Math.round(out.reduce((t, n) => t + n, 0) * 100) / 100).toBe(2.18);
  });

  it("AC-5 (guard): $10 + $20 at 8.25% (invoice 32.48) prices 10.83 + 21.65, as before", () => {
    const inv = invoiceOf(
      [
        { id: "a", qty: 1, subtotal: 10, taxRate: 0.0825 },
        { id: "b", qty: 1, subtotal: 20, taxRate: 0.0825 },
      ],
      2.48,
    );
    const a = priceMatchedChunk(candidate(inv, "a"), 1, false);
    const b = priceMatchedChunk(candidate(inv, "b"), 1, false);
    expect([gross(a), gross(b)]).toEqual([10.83, 21.65]);
  });

  it("AC-6: line 1 already taken at the old 7.04 (net 6.50, tax 0.54) leaves line 2 at 2.70, summing to 9.74", () => {
    const taken: TakenAmounts = { net: 6.5, tax: 0.54, categoryTax: 0 };
    const l2 = candidate(nine74, "l2", { invoiceTaken: taken });
    const b = priceMatchedChunk(l2, 1, false);
    expect(gross(b)).toBe(2.7);
    expect(Math.round((7.04 + gross(b)) * 100) / 100).toBe(9.74);
  });

  it("AC-6 (guard): with nothing taken before, the cap never bites (line 2 is 2.71)", () => {
    const b = priceMatchedChunk(
      candidate(nine74, "l2", { invoiceTaken: { net: 0, tax: 0, categoryTax: 0 } }),
      1,
      false,
    );
    expect(gross(b)).toBe(2.71);
  });

  it("AC-10 (guard): 3 then 4 of a 7-piece taxed line sum to that line's whole 7.03", () => {
    const inv = invoiceOf(
      [
        { id: "l1", qty: 7, subtotal: 6.5, taxRate: 0.0825 },
        { id: "l2", qty: 1, subtotal: 2.5, taxRate: 0.0825 },
      ],
      0.74,
    );
    const first = priceMatchedChunk(candidate(inv, "l1"), 3, false);
    const second = priceMatchedChunk(
      candidate(inv, "l1", {
        priorPieces: 3,
        priorAmounts: {
          net: first.subtotal,
          tax: first.taxAmount,
          categoryTax: first.categoryTax,
        },
      }),
      4,
      false,
    );
    expect(Math.round((gross(first) + gross(second)) * 100) / 100).toBe(7.03);
  });

  it("AC-11 (guard): a levy line credits its whole levy on a whole return and the slices add up", () => {
    // 10.00 line, 8% tax = 0.80 of which 0.30 is the category tax (levy): regular 0.50
    const inv = invoiceOf([{ id: "r", qty: 4, subtotal: 10, taxRate: 0.05, levy: 0.3 }], 0.8);
    const whole = priceMatchedChunk(candidate(inv, "r"), 4, false);
    expect(whole.categoryTax).toBe(0.3);
    expect(whole.taxAmount).toBe(0.5);
    const half = priceMatchedChunk(candidate(inv, "r"), 2, false);
    const rest = priceMatchedChunk(
      candidate(inv, "r", {
        priorPieces: 2,
        priorAmounts: { net: half.subtotal, tax: half.taxAmount, categoryTax: half.categoryTax },
      }),
      2,
      false,
    );
    expect(Math.round((half.categoryTax + rest.categoryTax) * 100) / 100).toBe(0.3);
    expect(Math.round((gross(half) + gross(rest)) * 100) / 100).toBe(10.8);
  });

  it("AC-13: the invoice discount leaves the NSF fee line out of its denominator ($8.00 net, not $9.43)", () => {
    const nsf = {
      id: "fee",
      subtotal: 25,
      qty: 1,
      taxRate: 0,
      categoryTaxAmount: 0,
      isNsf: true,
      systemKind: NSF_FEE_SYSTEM_KIND,
    } as unknown as RefundableInvoice["lines"][number];
    const inv = invoiceOf([{ id: "g", qty: 1, subtotal: 10 }], 0, 2, [nsf]);
    const priced = priceMatchedChunk(candidate(inv, "g", { invoiceSubtotal: 35 }), 1, false);
    expect(priced.subtotal).toBe(8);
  });

  it("AC-14 (guard): a customer exempt now still gets no tax back, as today", () => {
    const priced = priceMatchedChunk(candidate(nine74, "l1"), 1, true);
    expect(priced.taxAmount).toBe(0);
    expect(priced.subtotal).toBe(6.5);
  });

  it("AC-12: a lowered price never takes more tax than the default chunk did (tax is the levy alone, a stale 8.75% rate on the line)", () => {
    // the invoice charged only a $1.00 levy and no regular tax; the line still carries a rate
    const inv = invoiceOf([{ id: "x", qty: 1, subtotal: 10, taxRate: 0.0875, levy: 1 }], 1);
    const def = priceMatchedChunk(candidate(inv, "x"), 1, false);
    expect([def.subtotal, def.taxAmount, def.categoryTax]).toEqual([10, 0, 1]);
    const r = applyCreditOverride(
      def,
      { unitPrice: 9.5, reason: "damaged", overriddenBy: "u1" },
      { unitsPerBox: null, taxRate: 0.0875, taxExempt: false },
    );
    expect(r.overCap).toBe(false);
    if (r.overCap) return;
    expect(r.chunk.subtotal).toBe(9.5);
    expect(r.chunk.taxAmount).toBe(0); // rate x net would be 0.83, above the default's 0
    expect(gross(r.chunk)).toBeLessThanOrEqual(gross(def));
  });

  it("AC-12 (guard): a lowered price on a taxed line takes the tax of the lowered net, below the default's", () => {
    const def = priceMatchedChunk(candidate(nine74, "l1"), 1, false);
    const r = applyCreditOverride(
      def,
      { unitPrice: 5, reason: "damaged", overriddenBy: "u1" },
      { unitsPerBox: null, taxRate: 0.0825, taxExempt: false },
    );
    expect(r.overCap).toBe(false);
    if (r.overCap) return;
    expect([r.chunk.subtotal, r.chunk.taxAmount]).toEqual([5, 0.41]);
    expect(r.chunk.taxAmount).toBeLessThanOrEqual(def.taxAmount);
  });

  it("an invoice that charged no tax prices no tax whatever rate a line kept (m-7)", () => {
    const inv = invoiceOf([{ id: "x", qty: 1, subtotal: 10, taxRate: 0.08 }], 0);
    expect(priceMatchedChunk(candidate(inv, "x"), 1, false).taxAmount).toBe(0);
  });
});

describe("SA-1091 A-1 wiring pins", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const read = (f: string) =>
    require("fs").readFileSync(require("path").join(__dirname, f), "utf8");

  it("the pricer takes its slice from the helper and holds no proration of its own", () => {
    const src = read("inline-returns-pricing.ts");
    expect(src).toContain("refundableLineShare(");
    expect(src).not.toMatch(/creditedThrough\(/);
  });

  it("the quote reads every invoice item, hands each candidate the whole invoice, and tallies what each chunk takes", () => {
    const src = read("inline-returns-quote.service.ts");
    expect(src).toContain("refundableInvoiceOf(");
    expect(src).toContain("invoiceTaken");
    expect(src).toContain("noteChunkTaken(");
  });
});
