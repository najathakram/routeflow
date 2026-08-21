/**
 * Wave 2 (invoices money-complete): the client-side mirror of the server's
 * invoice money formula (apps/api/src/invoices/invoices.service.ts:202-287).
 * Every ordering rule here is a SERVER behaviour the preview must reproduce:
 * per-line discount before tax, invoice discount after tax, shipping untaxed,
 * per-line rounding, tax-exempt zeroing. Also locks invoiceLineDto's wire
 * shape — the API's forbidNonWhitelisted pipe 400s on any stray key.
 */
import { computeInvoiceTotals, editedLineFreeUnits, invoiceLineDto } from "../lib/invoice-totals";
import { computeLineSubtotal, roundMoney } from "../lib/pricing";

describe("computeInvoiceTotals", () => {
  it("plain lines: subtotal = Σ qty × unitPrice, rounded", () => {
    const t = computeInvoiceTotals({
      lines: [
        { unitPrice: 12, qty: 3 },
        { unitPrice: 4.5, qty: 2 },
      ],
    });
    expect(t).toEqual({
      subtotal: 45,
      taxTotal: 0,
      discount: 0,
      shippingFee: 0,
      total: 45,
      hasNegativeLine: false,
    });
  });

  it("boxed line prorates through computeLineSubtotal (never qty × box-price)", () => {
    // 2 cases + 3 loose of a 6-pack at $12/case → 12×2 + 12×(3/6) = $30.
    const line = { unitPrice: 12, qty: 15, boxes: 2, pieces: 3, unitsPerBox: 6 };
    const t = computeInvoiceTotals({ lines: [line] });
    expect(t.subtotal).toBe(30);
    expect(t.subtotal).toBe(roundMoney(computeLineSubtotal(line)));
  });

  it("per-line discount comes off BEFORE tax (tax charged on the discounted line)", () => {
    // $100 line, $20 off, 8% → tax on $80, not $100.
    const t = computeInvoiceTotals({
      lines: [{ unitPrice: 100, qty: 1, discount: 20, taxRate: 0.08 }],
    });
    expect(t.subtotal).toBe(80);
    expect(t.taxTotal).toBe(6.4);
    expect(t.total).toBe(86.4);
  });

  it("invoice-level discount comes off AFTER tax (never shrinks the tax base)", () => {
    const t = computeInvoiceTotals({
      lines: [{ unitPrice: 100, qty: 1, taxRate: 0.08 }],
      discount: 50,
    });
    // Tax stays 8% of $100 even though $50 comes off the total.
    expect(t.taxTotal).toBe(8);
    expect(t.total).toBe(58);
  });

  it("shipping is a flat post-tax addend — never taxed, never in subtotal", () => {
    const t = computeInvoiceTotals({
      lines: [{ unitPrice: 100, qty: 1, taxRate: 0.1 }],
      shippingFee: 15,
    });
    expect(t.subtotal).toBe(100);
    expect(t.taxTotal).toBe(10);
    expect(t.total).toBe(125);
  });

  it("isTaxExempt zeroes ALL tax (server checks customer.isTaxExempt; web's preview doesn't)", () => {
    const t = computeInvoiceTotals({
      lines: [{ unitPrice: 100, qty: 1, taxRate: 0.08 }],
      isTaxExempt: true,
    });
    expect(t.taxTotal).toBe(0);
    expect(t.total).toBe(100);
  });

  it("rounds per line then once per aggregate, exactly like the server", () => {
    // 3 × $0.335 = $1.005 → per-line round to $1.01 BEFORE summing. A
    // sum-then-round preview (web's create page) shows $1.00 here.
    const t = computeInvoiceTotals({
      lines: [
        { unitPrice: 0.335, qty: 3 },
        { unitPrice: 0.335, qty: 3 },
      ],
    });
    expect(t.subtotal).toBe(2.02);
  });

  it("tax sums across lines first, then rounds once (server: roundMoney(Σ sub × rate))", () => {
    // Each line's tax is $0.045 — rounding per line would give $0.05 + $0.05.
    const t = computeInvoiceTotals({
      lines: [
        { unitPrice: 0.9, qty: 1, taxRate: 0.05 },
        { unitPrice: 0.9, qty: 1, taxRate: 0.05 },
      ],
    });
    expect(t.taxTotal).toBe(0.09);
  });

  it("flags a line whose discount exceeds its subtotal (server rejects these)", () => {
    const t = computeInvoiceTotals({
      lines: [{ unitPrice: 10, qty: 1, discount: 15 }],
    });
    expect(t.hasNegativeLine).toBe(true);
    expect(t.subtotal).toBe(-5);
  });
});

describe("invoiceLineDto", () => {
  const TAX = 0.0825;

  it("catalog boxed line: keeps the split, maps taxable → tenant rate", () => {
    expect(
      invoiceLineDto(
        {
          description: "Cola 6-pack",
          productId: "p1",
          qty: 15,
          unitPrice: 12,
          boxes: 2,
          pieces: 3,
          unitsPerBox: 6,
          taxable: true,
        },
        TAX,
      ),
    ).toEqual({
      description: "Cola 6-pack",
      productId: "p1",
      qty: 15,
      unitPrice: 12,
      boxes: 2,
      pieces: 3,
      taxRate: TAX,
    });
  });

  it("not taxable → taxRate 0 on the wire (web's exact mapping)", () => {
    expect(
      invoiceLineDto({ description: "X", productId: "p1", qty: 1, unitPrice: 5 }, TAX),
    ).toMatchObject({ taxRate: 0 });
  });

  it("never leaks unitsPerBox/taxable, and drops the split for a productless line", () => {
    const dto = invoiceLineDto(
      {
        description: "Ad-hoc",
        qty: 6,
        unitPrice: 2,
        boxes: 1,
        pieces: 0,
        unitsPerBox: 6,
        taxable: true,
      },
      TAX,
    );
    // forbidNonWhitelisted: these keys would 400 the whole request.
    expect(dto).not.toHaveProperty("unitsPerBox");
    expect(dto).not.toHaveProperty("taxable");
    // Server only honours boxes/pieces with a productId — don't send them.
    expect(dto).not.toHaveProperty("boxes");
    expect(dto).not.toHaveProperty("pieces");
  });

  it("omits zero discount, keeps a real one; trims + omits empty notes", () => {
    expect(
      invoiceLineDto(
        { description: "X", productId: "p", qty: 1, unitPrice: 5, discount: 0, notes: "  " },
        TAX,
      ),
    ).not.toHaveProperty("discount");
    expect(
      invoiceLineDto(
        { description: "X", productId: "p", qty: 1, unitPrice: 5, discount: 1.5, notes: " keep " },
        TAX,
      ),
    ).toMatchObject({ discount: 1.5, notes: "keep" });
  });
});

// ─── BUY_N_GET_M on the edit screen ──────────────────────────────────────────
// The PATCH replaces every invoice line, so the snapshot has to survive the
// round trip or an agreed $350 line re-prices to 12 × $35 = $420 on save.

describe("editedLineFreeUnits + the BOGO wire shape", () => {
  it("keeps the agreed free units while the quantity is unchanged", () => {
    expect(editedLineFreeUnits({ promoFreeUnits: 2, promoBaseUnits: 12, qty: 12 })).toBe(2);
    const t = computeInvoiceTotals({ lines: [{ unitPrice: 35, qty: 12, freeUnits: 2 }] });
    expect(t.subtotal).toBe(350); // exact — never 29.17 × 12 drift, never $420
  });

  it("counts BOXES on a boxed line — loose pieces never earn or receive free units", () => {
    // 12 cases + 4 loose at $35/case, 2 cases free: 35 × (10 + 4/12) = 361.67.
    const line = { unitPrice: 35, qty: 148, boxes: 12, pieces: 4, unitsPerBox: 12 };
    const freeUnits = editedLineFreeUnits({ ...line, promoFreeUnits: 2, promoBaseUnits: 12 });
    expect(freeUnits).toBe(2);
    expect(computeInvoiceTotals({ lines: [{ ...line, freeUnits }] }).subtotal).toBeCloseTo(
      361.67,
      2,
    );
  });

  it("rescales down on a shrunk line and never above the agreed snapshot", () => {
    expect(editedLineFreeUnits({ promoFreeUnits: 2, promoBaseUnits: 12, qty: 6 })).toBe(1);
    expect(editedLineFreeUnits({ promoFreeUnits: 2, promoBaseUnits: 12, qty: 24 })).toBe(2);
    // A line is never entirely free — the buyer always pays the N in every (N + M).
    expect(editedLineFreeUnits({ promoFreeUnits: 2, promoBaseUnits: 12, qty: 1 })).toBe(0);
    expect(editedLineFreeUnits({ qty: 12 })).toBe(0); // non-BOGO line untouched
  });

  it("serialises promoFreeUnits only when the line has some", () => {
    expect(
      invoiceLineDto({ description: "X", qty: 12, unitPrice: 35, promoFreeUnits: 2 }, 0),
    ).toMatchObject({ promoFreeUnits: 2 });
    expect(invoiceLineDto({ description: "X", qty: 12, unitPrice: 35 }, 0)).not.toHaveProperty(
      "promoFreeUnits",
    );
  });
});
