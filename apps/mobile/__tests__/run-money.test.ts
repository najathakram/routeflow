/**
 * REG-B49: every driver money figure must derive from the server's box-aware line money,
 * never `qty * unitPrice` for a boxed line (spec R2, test-plan T-B49m). `lib/run-money.ts`
 * does not exist as a real implementation yet — imports resolve against a signature-only
 * stub so these fail on assertion, not on module resolution.
 */
import {
  deliveredCategoryTax,
  earlierVisitsRemaining,
  lineItemSubtotal,
  orderAmountDue,
  reconciledAmountDue,
  reconciledDoorDue,
  shortPickCategoryTax,
  stopAmountDue,
  sumOrderLineItems,
  sumStopOrders,
  type RunMoneyPayableInvoice,
} from "../lib/run-money";
import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";
import { freeUnitSizeFor, reconciledTotal, type ShortPickLine } from "../lib/short-pick";

describe("lineItemSubtotal (REG-B49)", () => {
  it("uses the server-computed subtotal for a boxed line, never qty * unitPrice", () => {
    // 2 boxes @ $30/box = $60.00. The wrong basis (qty 48 * unitPrice 30) inflates
    // this by unitsPerBox (24x) to $1,440 — the exact bug this test pins.
    const line = {
      qty: 48,
      unitPrice: 30,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 24,
      subtotal: "60.00",
    };
    expect(lineItemSubtotal(line)).toBe(60);
    expect(lineItemSubtotal(line)).not.toBe(1440);
  });

  it("coerces a string-Decimal subtotal via Number()", () => {
    expect(lineItemSubtotal({ qty: 1, unitPrice: 5, subtotal: "12.34" })).toBe(12.34);
  });

  it("falls back to computeLineSubtotal when the line carries no subtotal", () => {
    const line = { qty: 48, unitPrice: 30, boxes: 2, pieces: 0, unitsPerBox: 24 };
    // Oracle: computeLineSubtotal itself (2 box-equivalents * $30 = $60), never NaN/0.
    const expected = computeLineSubtotal({
      unitPrice: 30,
      qty: 48,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 24,
    });
    expect(expected).toBe(60);
    expect(lineItemSubtotal(line)).toBe(60);
  });

  it("preserves qty * unitPrice equivalence for a loose line (unitsPerBox null)", () => {
    const line = { qty: 5, unitPrice: 12, boxes: null, pieces: null, unitsPerBox: null };
    expect(lineItemSubtotal(line)).toBe(60); // 5 * 12, no box proration applies
  });

  it("preserves qty * unitPrice equivalence for a loose line (unitsPerBox 1)", () => {
    expect(lineItemSubtotal({ qty: 3, unitPrice: 10, unitsPerBox: 1 })).toBe(30); // 3 * 10
  });

  it("still prefers a stored subtotal over qty * unitPrice on a loose line", () => {
    expect(lineItemSubtotal({ qty: 5, unitPrice: 12, unitsPerBox: 1, subtotal: "75.00" })).toBe(75);
  });
});

describe("sumOrderLineItems / sumStopOrders (REG-B49)", () => {
  it("sums an order's line items via lineItemSubtotal", () => {
    const order = {
      lineItems: [
        // boxed, server subtotal -> $60.00
        { qty: 48, unitPrice: 30, boxes: 2, pieces: 0, unitsPerBox: 24, subtotal: "60.00" },
        // loose, no subtotal -> falls back to 3 * 10 = $30.00
        { qty: 3, unitPrice: 10, unitsPerBox: 1 },
      ],
    };
    expect(sumOrderLineItems(order)).toBe(90);
  });

  it("sums every order at a stop", () => {
    const stop = {
      orders: [
        {
          lineItems: [
            { qty: 48, unitPrice: 30, boxes: 2, pieces: 0, unitsPerBox: 24, subtotal: "60.00" },
            { qty: 3, unitPrice: 10, unitsPerBox: 1 },
          ],
        },
        { lineItems: [{ qty: 2, unitPrice: 5, unitsPerBox: 1 }] }, // fallback -> $10.00
      ],
    };
    expect(sumStopOrders(stop)).toBe(100);
  });

  it("treats a stop with no orders as zero", () => {
    expect(sumStopOrders({})).toBe(0);
  });
});

/**
 * REG-B305 round 2 (Opus BLOCKER on round 1's basis): `Order.total` carries
 * NO discount and, on a split delivery, bills the WHOLE shipping fee on
 * every visit — it is not what the invoice actually bills. The driver's
 * amount due must be the order's own PAYABLE INVOICE(S) as the server last
 * computed them (B810: `order.payableInvoices[].balanceDue`, server-computed
 * as `total - confirmed payments` — reduces to `total` here since these
 * fixtures carry no payments, byte-identical to the pre-B810 basis). These
 * fixtures pin that basis; before the ORIGINAL fix, `orderAmountDue`/
 * `reconciledAmountDue` read `order.total` directly and the discount/
 * split-fee assertions below are red on the WRONG (pre-fix) value, not on a
 * missing export.
 */
describe("REG-B305 tax-inclusive amount due (round 2: read off the draft invoice)", () => {
  it("REG-B305 the bug's own numbers: quotes and collects the draft invoice's total", () => {
    const order = {
      lineItems: [{ qty: 1, unitPrice: 116.83, subtotal: 116.83 }],
      payableInvoices: [{ id: "inv-1", status: "DRAFT", balanceDue: "128.51" }],
    };
    expect(orderAmountDue(order as any)).toBe(128.51);
    // Driver collected $130 cash; change should be $1.49, not $13.17 (pre-tax basis).
    const change = Math.max(0, 130 - orderAmountDue(order as any));
    expect(change).toBeCloseTo(1.49, 2);
  });

  it("REG-B305 Opus BLOCKER: a discount on the draft wins, never Order.total's discount-less figure", () => {
    // Order.total (110) carries no discount; the draft (95) is what the
    // invoice actually bills.
    const order = {
      lineItems: [],
      subtotal: 100,
      tax: 10,
      total: 110,
      discountAmount: 15,
      payableInvoices: [{ id: "inv-1", status: "DRAFT", balanceDue: 95 }],
    };
    expect(orderAmountDue(order as any)).toBe(95);
    expect(orderAmountDue(order as any)).not.toBe(110);
  });

  it("REG-B305 a split delivery's allocated fee is read off the draft, never Order.total's whole fee", () => {
    // Order.total (121) is the WHOLE shipping fee applied on every visit —
    // the draft carries the fee actually allocated to THIS visit.
    const baseOrder = { lineItems: [], subtotal: 50, tax: 5, total: 121 };
    const firstVisit = {
      ...baseOrder,
      payableInvoices: [{ id: "inv-1", status: "DRAFT", balanceDue: 65 }],
    };
    expect(orderAmountDue(firstVisit as any)).toBe(65);
    const secondVisit = {
      ...baseOrder,
      payableInvoices: [{ id: "inv-2", status: "DRAFT", balanceDue: 55 }],
    };
    expect(orderAmountDue(secondVisit as any)).toBe(55);
    expect(orderAmountDue(secondVisit as any)).not.toBe(121);
  });

  it("REG-B305 RULING 1: sums ALL open drafts, not just the first (a regulated split can have several)", () => {
    const order = {
      lineItems: [],
      payableInvoices: [
        { id: "base", status: "DRAFT", balanceDue: 120 },
        { id: "base-R1", status: "DRAFT", balanceDue: 80 },
      ],
    };
    expect(orderAmountDue(order as any)).toBe(200);
  });

  // B305 round 5: NO open draft is the DEFAULT state for a route order (the
  // server only creates/reconciles one at stop-completion) — this used to
  // fall back to the bare pre-tax line sum, so essentially every driver saw
  // a pre-tax quote on essentially every stop. RULING 2 still stands
  // (`Order.total` is never read here) but `Order.tax`/`Order.subtotal` are
  // safe: every order-mutating path recomputes both fresh from the current
  // line set, unlike `Order.total`'s discount term.
  describe("REG-B305 round 5: without an open draft, the fallback is tax-inclusive, never the bare pre-tax line sum", () => {
    it("repro: qty 1 @ 116.83, order.tax 11.68 (10%), no draft -> 128.51, not the pre-tax 116.83", () => {
      const order = {
        lineItems: [{ qty: 1, unitPrice: 116.83, subtotal: 116.83, status: "PENDING" }],
        subtotal: 116.83,
        tax: 11.68,
      };
      expect(orderAmountDue(order as any)).toBe(128.51);
      expect(orderAmountDue(order as any)).not.toBe(sumOrderLineItems(order as any));
    });

    it("excludes a CANCELLED line's subtotal AND its stale categoryTaxAmount snapshot from the quote", () => {
      // Line A 100.00; regulated line B 50.00 (categoryTaxAmount 7.50);
      // CANCELLED line C: qty 0, subtotal 0, but its categoryTaxAmount
      // snapshot was never zeroed on cancel (the server's line-cancel
      // writers zero subtotal, not categoryTaxAmount) — must not leak in.
      const order = {
        lineItems: [
          { qty: 2, unitPrice: 50, subtotal: 100, status: "PENDING" },
          { qty: 1, unitPrice: 50, subtotal: 50, categoryTaxAmount: 7.5, status: "PENDING" },
          { qty: 0, unitPrice: 20, subtotal: 0, categoryTaxAmount: 4, status: "CANCELLED" },
        ],
        subtotal: 150,
        tax: 15,
      };
      expect(orderAmountDue(order as any)).toBe(172.5);
      // Pins the two specific wrong values a partial fix would produce.
      expect(orderAmountDue(order as any)).not.toBe(176.5); // no cancelled-line filter
      expect(orderAmountDue(order as any)).not.toBe(165); // regular tax only, no category tax
    });

    it("an exempt customer's fallback zeroes BOTH tax terms, same repro line", () => {
      // categoryTaxAmount 7.50 on the line: without it, this fixture can't
      // tell "zeroes BOTH regular tax AND category tax" apart from "zeroes
      // only regular tax" — there'd be no category tax present to leak.
      const order = {
        lineItems: [
          {
            qty: 1,
            unitPrice: 116.83,
            subtotal: 116.83,
            categoryTaxAmount: 7.5,
            status: "PENDING",
          },
        ],
        subtotal: 116.83,
        tax: 11.68,
      };
      expect(orderAmountDue(order as any, true)).toBe(116.83);
      expect(orderAmountDue(order as any, true)).not.toBe(124.33); // 116.83 + leaked 7.50 category tax
    });

    it("an exempt customer's proportional-tax fixture (r = 0.5): still zero, never a fraction of either tax term", () => {
      // active-line subtotal 50 vs order.subtotal 100 -> r = 0.5. Exempt
      // zeroes both terms outright — r never enters the exempt branch at all,
      // so this must read 50 flat, never 50 + half of anything.
      const order = {
        lineItems: [
          { qty: 1, unitPrice: 50, subtotal: 50, categoryTaxAmount: 6, status: "PENDING" },
        ],
        subtotal: 100,
        tax: 10,
      };
      expect(orderAmountDue(order as any, true)).toBe(50);
    });

    it("pins the proportional regularTax at r = 0.5 (active-line subtotal is HALF of order.subtotal)", () => {
      // Active lines sum to 50 while order.subtotal is 100 (r = 0.5) — a line
      // removed from the client's lineItems snapshot without a fresh
      // order.subtotal write. regularTax = 10 * 0.5 = 5; categoryTax = 3
      // (full stored value, never scaled by r). due = 50 + 5 + 3 = 58.
      const order = {
        lineItems: [
          { qty: 1, unitPrice: 50, subtotal: 50, categoryTaxAmount: 3, status: "PENDING" },
        ],
        subtotal: 100,
        tax: 10,
      };
      expect(orderAmountDue(order as any)).toBe(58);
      expect(orderAmountDue(order as any)).not.toBe(63); // r=1 mistake: regularTax 10 flat, not 5
    });

    it("subtracts the order's own discount and adds its shipping fee, whole, never prorated", () => {
      const order = {
        lineItems: [{ qty: 1, unitPrice: 116.83, subtotal: 116.83, status: "PENDING" }],
        subtotal: 116.83,
        tax: 11.68,
        discountAmount: 10,
        shippingFee: 5,
      };
      expect(orderAmountDue(order as any)).toBe(123.51);
    });

    it("falls back to the pre-tax line sum only in the sense that missing tax/discount/fee fields default to zero — never NaN", () => {
      const order = { lineItems: [{ qty: 2, unitPrice: 10, subtotal: 20, status: "PENDING" }] };
      const due = orderAmountDue(order as any);
      expect(due).toBe(20);
      expect(Number.isNaN(due)).toBe(false);
    });

    it("a malformed order.tax/order.subtotal falls back to untaxed, never NaN", () => {
      const order = {
        lineItems: [{ qty: 2, unitPrice: 10, subtotal: 20, status: "PENDING" }],
        subtotal: "garbage",
        tax: "garbage",
      };
      const due = orderAmountDue(order as any);
      expect(due).toBe(20);
      expect(Number.isNaN(due)).toBe(false);
    });

    // SA-092b: this is the ACTUAL guard-removal repro (the earlier "exempt
    // customer's fallback" tests above all supplied order.subtotal, so none
    // of them exercised the `orderSubtotal == null` bail at all — removing
    // the guard left every one of them green). order.subtotal is absent
    // here, matching an OTA of this mobile fix shipped ahead of #1272's
    // server deploy.
    it("GUARD: order.subtotal entirely absent (pre-#1272-deploy shape) -> bare active subtotal, never the leaked category tax", () => {
      const order = {
        lineItems: [{ subtotal: 100, categoryTaxAmount: 8, status: "PENDING" }],
        // subtotal/tax intentionally absent.
      };
      expect(orderAmountDue(order as any)).toBe(100);
      expect(orderAmountDue(order as any)).not.toBe(108); // the leaked categoryTaxAmount
    });

    it("GUARD via stopAmountDue: same repro, exercised through the real caller chain", () => {
      const stop = {
        orders: [{ lineItems: [{ subtotal: 100, categoryTaxAmount: 8, status: "PENDING" }] }],
        customer: {},
      };
      expect(stopAmountDue(stop as any)).toBe(100);
      expect(stopAmountDue(stop as any)).not.toBe(108);
    });

    // SA-092b: a GENUINELY zero order.subtotal is NOT the guard case (the
    // field IS present) — r lands at 0 via `orderSubtotal || 1`, matching
    // the server's own `Number(order.subtotal) || 1` pattern exactly.
    it("a genuinely $0 order.subtotal is not the guard case: fee stays whole, discount and tax scale to zero (r = 0)", () => {
      const order = {
        lineItems: [],
        subtotal: 0,
        tax: 0,
        discountAmount: 3,
        shippingFee: 5,
      };
      expect(orderAmountDue(order as any)).toBe(5);
      expect(orderAmountDue(order as any)).not.toBe(2); // whole discount (0 - 3 + 5) — the old bug
    });

    it("pins discount x r at r = 0.5 (active-line subtotal is HALF of order.subtotal)", () => {
      // Active lines sum to 50, order.subtotal 100 -> r = 0.5. discount 10 x
      // 0.5 = 5 subtracted, never the whole 10.
      const order = {
        lineItems: [{ qty: 1, unitPrice: 50, subtotal: 50, status: "PENDING" }],
        subtotal: 100,
        tax: 0,
        discountAmount: 10,
      };
      expect(orderAmountDue(order as any)).toBe(45); // 50 - 5
      expect(orderAmountDue(order as any)).not.toBe(40); // whole discount (50 - 10) — the old bug
    });
  });

  it("REG-B305 coerces string-Decimal draft totals", () => {
    const base = { lineItems: [{ qty: 1, unitPrice: 10, subtotal: 10 }] };
    expect(
      orderAmountDue({
        ...base,
        payableInvoices: [{ id: "i1", status: "DRAFT", balanceDue: "10" }],
      } as any),
    ).toBe(10);
  });

  it("REG-B305 stopAmountDue mixes a draft-bearing order with a legacy order, never NaN", () => {
    const draftOrder = {
      lineItems: [],
      payableInvoices: [{ id: "i1", status: "DRAFT", balanceDue: 55 }],
    };
    const legacyOrder = { lineItems: [{ qty: 1, unitPrice: 20, subtotal: 20 }] };
    // No draft AND a malformed total -> falls all the way to the line sum.
    const brokenOrder = { lineItems: [{ qty: 1, unitPrice: 5, subtotal: 5 }], total: "garbage" };
    expect(stopAmountDue({ orders: [draftOrder, legacyOrder, brokenOrder] } as any)).toBe(80);
  });

  it("stopAmountDue: an exempt customer's no-draft order with category tax zeroes BOTH tax terms at the stop level", () => {
    // No draft (the default pre-completion state) -> orderAmountDue's
    // fallback runs. categoryTaxAmount 8 on the line: an exempt customer
    // must not see it leak in via stopAmountDue's isTaxExempt plumbing
    // (stop.customer.isTaxExempt -> orderAmountDue's isTaxExempt param).
    const order = {
      lineItems: [
        { qty: 1, unitPrice: 100, subtotal: 100, categoryTaxAmount: 8, status: "PENDING" },
      ],
      subtotal: 100,
      tax: 10,
    };
    const stop = { orders: [order], customer: { isTaxExempt: true } };
    expect(stopAmountDue(stop as any)).toBe(100);
    expect(stopAmountDue(stop as any)).not.toBe(118); // regular tax (10) + leaked category tax (8)
    expect(stopAmountDue(stop as any)).not.toBe(110); // regular tax leaked, category tax correctly zeroed
  });
});

/**
 * REG-B810 (SA-125 ruling): once an order's invoice progresses past DRAFT
 * (SENT/PARTIAL), the driver's amount due must reflect what the invoice
 * ACTUALLY still owes — `balanceDue = total - confirmed payments`, server-
 * computed — never the invoice's raw `total` re-billed as if nothing had
 * been paid. Before the fix, `orderAmountDue` read `order.invoices[]`, which
 * only ever carried DRAFT invoices (`deliveryBatchId: null`) — a SENT or
 * PARTIAL invoice was invisible to it, so a part-paid order fell through to
 * the order-total fallback and re-quoted the driver the FULL original total.
 */
describe("REG-B810 orderAmountDue sums payableInvoices[].balanceDue, including SENT/PARTIAL", () => {
  it("a SENT invoice already paid 40 of 100 -> balanceDue 60, never the raw total 100", () => {
    const order = {
      lineItems: [],
      payableInvoices: [{ id: "inv-1", status: "SENT", balanceDue: 60 }],
    };
    expect(orderAmountDue(order as any)).toBe(60);
    expect(orderAmountDue(order as any)).not.toBe(100);
  });

  it("a PARTIAL invoice's balanceDue is used as-is, never its total", () => {
    const order = {
      lineItems: [],
      payableInvoices: [{ id: "inv-1", status: "PARTIAL", balanceDue: 25 }],
    };
    expect(orderAmountDue(order as any)).toBe(25);
  });

  it("SA-125 worked example: DRAFT 50 + PARTIAL 100/paid 40 (balanceDue 60) -> 110, not 150", () => {
    const order = {
      lineItems: [],
      payableInvoices: [
        { id: "draft-1", status: "DRAFT", balanceDue: 50 },
        { id: "partial-1", status: "PARTIAL", balanceDue: 60 },
      ],
    };
    expect(orderAmountDue(order as any)).toBe(110);
    expect(orderAmountDue(order as any)).not.toBe(150); // 50 + the PARTIAL's raw total (100)
  });

  it("an OVERDUE invoice's balanceDue is summed the same as SENT/PARTIAL", () => {
    const order = {
      lineItems: [],
      payableInvoices: [{ id: "inv-1", status: "OVERDUE", balanceDue: 30 }],
    };
    expect(orderAmountDue(order as any)).toBe(30);
  });
});

describe("REG-B810 earlierVisitsRemaining", () => {
  it("sums balanceDue across non-DRAFT payable invoices", () => {
    const payableInvoices = [
      { id: "sent-1", status: "SENT", balanceDue: 60 },
      { id: "partial-1", status: "PARTIAL", balanceDue: 25 },
    ];
    expect(earlierVisitsRemaining(payableInvoices as any)).toBe(85);
  });

  it("excludes DRAFT invoices from the sum", () => {
    const payableInvoices = [
      { id: "draft-1", status: "DRAFT", balanceDue: 50 },
      { id: "sent-1", status: "SENT", balanceDue: 60 },
    ];
    expect(earlierVisitsRemaining(payableInvoices as any)).toBe(60);
  });

  it("returns 0 for an empty list", () => {
    expect(earlierVisitsRemaining([])).toBe(0);
  });

  it("coerces a string-Decimal balanceDue and rounds the sum", () => {
    const payableInvoices = [
      { id: "sent-1", status: "SENT", balanceDue: "10.005" },
      { id: "sent-2", status: "SENT", balanceDue: "0.005" },
    ];
    expect(earlierVisitsRemaining(payableInvoices as any)).toBe(10.01);
  });

  it("ignores a non-finite balanceDue rather than producing NaN", () => {
    const payableInvoices = [
      { id: "sent-1", status: "SENT", balanceDue: 60 },
      { id: "sent-2", status: "SENT", balanceDue: "garbage" },
    ];
    expect(earlierVisitsRemaining(payableInvoices as any)).toBe(60);
  });
});

/**
 * REG-B810 round 2 (SA-130a/Opus): SA-125's original shape
 * (`reconciledAmountDue(...) + earlierVisitsRemaining(...)`, unconditionally
 * added in payment.tsx) double-counted once an order had no open draft and
 * its only payable was a plain, already-finalized invoice. `reconciledDoorDue`
 * is the fix: the caller's one decision point, per order, on the reconciled
 * path.
 */
describe("REG-B810 reconciledDoorDue (SA-130a)", () => {
  it("SA-130a's own repro: SENT 100 (no payments), no draft, short-picked to a reconciled estimate of 90 -> the invoice's OWN balanceDue (100), never ~190", () => {
    const payableInvoices: RunMoneyPayableInvoice[] = [
      { id: "inv-1", status: "SENT", total: 100, balanceDue: 100, isDepositMirror: false },
    ];
    const due = reconciledDoorDue({
      hasOpenDraft: false,
      reconciledEstimate: 90, // what a short-picked re-derivation of the order would give
      payableInvoices,
    });
    expect(due).toBe(100);
    expect(due).not.toBeCloseTo(190, 0);
  });

  it("(a) an open draft exists: reconciledEstimate + Σ balanceDue over the non-DRAFT payables — the existing SA-125 shape, unchanged", () => {
    const payableInvoices: RunMoneyPayableInvoice[] = [
      { id: "draft-1", status: "DRAFT", total: 50, balanceDue: 50, isDepositMirror: false },
      { id: "partial-1", status: "PARTIAL", total: 100, balanceDue: 60, isDepositMirror: false },
    ];
    const due = reconciledDoorDue({
      hasOpenDraft: true,
      reconciledEstimate: 50, // the draft's own reconciled figure
      payableInvoices,
    });
    expect(due).toBe(110); // the existing 110 example, unchanged
  });

  it("(a) also covers no payable invoice at all yet: reduces to the bare reconciled estimate, never 0", () => {
    const due = reconciledDoorDue({
      hasOpenDraft: false,
      reconciledEstimate: 128.51,
      payableInvoices: [],
    });
    expect(due).toBe(128.51);
  });

  it("(b) no open draft, the sole payable is a deposit mirror: reconciledEstimate minus what the mirror already collected", () => {
    // A SENT deposit mirror of 100 with 30 paid (balanceDue 70), short-picked
    // to a restated reconciledEstimate of 70 -> 70 - (100-70) = 40.
    const payableInvoices: RunMoneyPayableInvoice[] = [
      { id: "mirror-1", status: "SENT", total: 100, balanceDue: 70, isDepositMirror: true },
    ];
    const due = reconciledDoorDue({
      hasOpenDraft: false,
      reconciledEstimate: 70,
      payableInvoices,
    });
    expect(due).toBe(40);
  });

  it("(b) an unpaid deposit mirror subtracts nothing — reconciledEstimate passes through unchanged", () => {
    const payableInvoices: RunMoneyPayableInvoice[] = [
      { id: "mirror-1", status: "SENT", total: 100, balanceDue: 100, isDepositMirror: true },
    ];
    const due = reconciledDoorDue({ hasOpenDraft: false, reconciledEstimate: 60, payableInvoices });
    expect(due).toBe(60);
  });

  it("(c) no open draft, a plain (non-mirror) payable: Σ balanceDue ONLY — the reconciled estimate is never added on top", () => {
    const payableInvoices: RunMoneyPayableInvoice[] = [
      { id: "inv-1", status: "SENT", total: 100, balanceDue: 60, isDepositMirror: false },
    ];
    const due = reconciledDoorDue({
      hasOpenDraft: false,
      reconciledEstimate: 90, // a wrong-shaped caller would add this on top -- must be ignored
      payableInvoices,
    });
    expect(due).toBe(60);
  });

  it("(c) sums MULTIPLE plain payables (a regulated split with no draft) rather than picking just one", () => {
    const payableInvoices: RunMoneyPayableInvoice[] = [
      { id: "base", status: "SENT", total: 60, balanceDue: 60, isDepositMirror: false },
      { id: "base-R1", status: "PARTIAL", total: 40, balanceDue: 30, isDepositMirror: false },
    ];
    const due = reconciledDoorDue({
      hasOpenDraft: false,
      reconciledEstimate: 999,
      payableInvoices,
    });
    expect(due).toBe(90);
  });

  it("SA-130b's exact repro: order 100, a 40 advance applied on the DRAFT, short-picked to an estimate of 90 -> the door shows 50, matching what recordDeliveryPaymentInTx collects (never the un-netted 90)", () => {
    const payableInvoices: RunMoneyPayableInvoice[] = [
      { id: "draft-1", status: "DRAFT", total: 100, balanceDue: 60, isDepositMirror: false },
    ];
    const due = reconciledDoorDue({
      hasOpenDraft: true,
      reconciledEstimate: 90,
      payableInvoices,
    });
    expect(due).toBe(50);
  });

  it("fleet-lead round 2 pin (F2/B822): a $100 DRAFT with a $30 confirmed advance, short-picked to an estimate of $60 -> the door shows $30", () => {
    const payableInvoices: RunMoneyPayableInvoice[] = [
      { id: "draft-1", status: "DRAFT", total: 100, balanceDue: 70, isDepositMirror: false },
    ];
    const due = reconciledDoorDue({
      hasOpenDraft: true,
      reconciledEstimate: 60,
      payableInvoices,
    });
    expect(due).toBe(30);
  });

  it("F2: the draft-already-paid subtraction composes with earlierVisitsRemaining over OTHER non-DRAFT payables", () => {
    const payableInvoices: RunMoneyPayableInvoice[] = [
      { id: "draft-1", status: "DRAFT", total: 100, balanceDue: 70, isDepositMirror: false },
      { id: "sent-1", status: "SENT", total: 40, balanceDue: 40, isDepositMirror: false },
    ];
    const due = reconciledDoorDue({
      hasOpenDraft: true,
      reconciledEstimate: 60,
      payableInvoices,
    });
    expect(due).toBe(70); // 60 - (100-70) + 40
  });

  it("Opus round 4: case (a) floors the draft-netted estimate at 0 -- draft 100 total, fully paid (balanceDue 0), short-picked to an estimate of 90 -> 0, never -10", () => {
    const payableInvoices: RunMoneyPayableInvoice[] = [
      { id: "draft-1", status: "DRAFT", total: 100, balanceDue: 0, isDepositMirror: false },
    ];
    const due = reconciledDoorDue({
      hasOpenDraft: true,
      reconciledEstimate: 90,
      payableInvoices,
    });
    expect(due).toBe(0);
    expect(due).not.toBeLessThan(0);
  });

  it("Opus round 4: a draft overpayment never offsets an unrelated SENT balance -- floors the draft term alone, then adds the SENT balance whole", () => {
    const payableInvoices: RunMoneyPayableInvoice[] = [
      { id: "draft-1", status: "DRAFT", total: 100, balanceDue: 0, isDepositMirror: false },
      { id: "sent-1", status: "SENT", total: 50, balanceDue: 50, isDepositMirror: false },
    ];
    const due = reconciledDoorDue({
      hasOpenDraft: true,
      reconciledEstimate: 90,
      payableInvoices,
    });
    expect(due).toBe(50); // max(0, 90-100) + 50 = 0 + 50, never 90-100+50=40
  });

  it("F3: a PARTIAL mirror of $100 with $70 paid, restated to $50 -> floors at 0, never negative", () => {
    const payableInvoices: RunMoneyPayableInvoice[] = [
      { id: "mirror-1", status: "PARTIAL", total: 100, balanceDue: 30, isDepositMirror: true },
    ];
    const due = reconciledDoorDue({
      hasOpenDraft: false,
      reconciledEstimate: 50,
      payableInvoices,
    });
    expect(due).toBe(0);
    expect(due).not.toBeLessThan(0);
  });

  it("F3: a two-order stop sums correctly when one order's mirror floors at 0 and the other has a normal positive due", () => {
    const orderA = reconciledDoorDue({
      hasOpenDraft: false,
      reconciledEstimate: 50,
      payableInvoices: [
        { id: "mirror-1", status: "PARTIAL", total: 100, balanceDue: 30, isDepositMirror: true },
      ],
    });
    const orderB = reconciledDoorDue({
      hasOpenDraft: false,
      reconciledEstimate: 999,
      payableInvoices: [
        { id: "sent-1", status: "SENT", total: 25, balanceDue: 25, isDepositMirror: false },
      ],
    });
    expect(orderA + orderB).toBe(25); // 0 + 25, never a negative order dragging the stop total down
  });

  it("F4 (LOW): case (c) includes a DRAFT-status payable in the plain Σ balanceDue sum, never silently dropped via earlierVisitsRemaining's DRAFT exclusion", () => {
    // hasOpenDraft is false (the separate o.invoices projection saw no open
    // draft), yet payableInvoices still carries a DRAFT-status row -- must
    // still be summed, not excluded the way case (a)'s earlierVisitsRemaining
    // would exclude it.
    const payableInvoices: RunMoneyPayableInvoice[] = [
      { id: "draft-1", status: "DRAFT", total: 40, balanceDue: 40, isDepositMirror: false },
      { id: "sent-1", status: "SENT", total: 60, balanceDue: 60, isDepositMirror: false },
    ];
    const due = reconciledDoorDue({
      hasOpenDraft: false,
      reconciledEstimate: 999,
      payableInvoices,
    });
    expect(due).toBe(100); // 40 + 60, DRAFT included
  });
});

/**
 * REG-B305 round 2 (RULING 3): the short-pick estimate must follow the
 * SERVER's own delivered-basis rule (invoices.service.ts ~1447-1473) — regular
 * tax scales by the delivered share of the ORDER's own subtotal, category tax
 * is the Σ of each DELIVERED line's own snapshot (never the draft's whole
 * `taxAmount` prorated by subtotal share), and discount/fee stay whole.
 * Before the fix, `reconciledAmountDue` prorated the whole draft `taxAmount`
 * uniformly — Opus's A-only worked example below gave $135 (wrong), not $110.
 */
describe("deliveredCategoryTax (REG-B305 RULING 3)", () => {
  it("REG-B305 scales a line's snapshotted category tax by its delivered/ordered qty share", () => {
    const lines = [{ id: "x", qty: 10, unitPrice: 1, categoryTaxAmount: 50 }];
    expect(deliveredCategoryTax(lines, { x: 4 })).toBe(20);
  });

  it("REG-B305 sums across lines; a line missing from the plan defaults to fully delivered", () => {
    const lines = [
      { id: "a", qty: 1, unitPrice: 100, categoryTaxAmount: 0 },
      { id: "b", qty: 1, unitPrice: 100, categoryTaxAmount: 50 },
    ];
    expect(deliveredCategoryTax(lines, { a: 1, b: 0 })).toBe(0);
    expect(deliveredCategoryTax(lines, { a: 0, b: 1 })).toBe(50);
    expect(deliveredCategoryTax(lines, {})).toBe(50); // both default to fully delivered
  });

  it("REG-B305 never divides by zero on a qty-0 line", () => {
    const lines = [{ id: "z", qty: 0, unitPrice: 1, categoryTaxAmount: 50 }];
    expect(deliveredCategoryTax(lines, { z: 0 })).toBe(0);
  });
});

describe("reconciledAmountDue (REG-B305 RULING 3: the server's delivered-basis rule)", () => {
  it("REG-B305 Opus's worked example: category tax follows the DELIVERED lines, never the whole draft tax prorated by subtotal share", () => {
    // order subtotal 200, tax (regular) 20; lines A {subtotal 100, categoryTaxAmount 0}
    // and B {subtotal 100, categoryTaxAmount 50}; one draft {total 270}.
    const order = { subtotal: 200, tax: 20 };
    const drafts = [{ discount: 0, shippingFee: 0 }];
    // Deliver A only: today's helper prorates the WHOLE draft tax by subtotal
    // share (70 * 100/200 = 35) -> 135. The server's own rule instead charges
    // only A's $0 category tax -> 110.
    expect(
      reconciledAmountDue({ drafts, order, deliveredSubtotal: 100, deliveredCategoryTax: 0 }),
    ).toBe(110);
    // Deliver B only: same deliveredSubtotal (100) but B's $50 category tax
    // -> 160 (today's helper can't tell A and B apart and would also say 135).
    expect(
      reconciledAmountDue({ drafts, order, deliveredSubtotal: 100, deliveredCategoryTax: 50 }),
    ).toBe(160);
    // Deliver both -> equals the draft's own total (consistency check).
    expect(
      reconciledAmountDue({ drafts, order, deliveredSubtotal: 200, deliveredCategoryTax: 50 }),
    ).toBe(270);
  });

  it("REG-B305 discount and shipping fee stay WHOLE — only tax and category tax prorate by the delivered share", () => {
    const order = { subtotal: 100, tax: 10 };
    const drafts = [{ discount: 15, shippingFee: 10 }];
    // Deliver half, no category tax: 50 - 15 + 10 + (10 * 50/100) + 0 = 50.
    expect(
      reconciledAmountDue({ drafts, order, deliveredSubtotal: 50, deliveredCategoryTax: 0 }),
    ).toBe(50);
  });

  // B305 round 5: NO open draft is the DEFAULT state pre-completion — this
  // used to bail out to the bare pre-tax `deliveredSubtotal`, so a
  // short-picked stop omitted tax on every normal delivery. Now falls
  // through to the SAME formula, sourcing discount/fee from the order's own
  // columns instead of a (nonexistent) draft.
  it("repro: order 116.83/11.68 (10%), delivered exactly half (58.42), no draft -> 64.26, not the bare 58.42", () => {
    expect(
      reconciledAmountDue({
        drafts: [],
        order: { subtotal: 116.83, tax: 11.68 },
        deliveredSubtotal: 58.42,
        deliveredCategoryTax: 0,
      }),
    ).toBe(64.26);
  });

  it("with no draft, sources discount/shippingFee from the order's own columns", () => {
    // 42 - 5(discount) + 3(fee) + 10*(42/100) + 5(categoryTax) = 49.2
    expect(
      reconciledAmountDue({
        drafts: [],
        order: { subtotal: 100, tax: 10, discountAmount: 5, shippingFee: 3 },
        deliveredSubtotal: 42,
        deliveredCategoryTax: 5,
      }),
    ).toBe(49.2);
  });

  // SA-092b: the discount's share is the SEEDING share (activeSubtotal /
  // orderSubtotal), NEVER the delivered share applied to regular tax — the
  // server seeds the discount at the active-line share when the invoice is
  // first created and the delivered-basis rebuild never re-scales it.
  it("SA-092b discriminator: delivered share 0.5, seeding share (r_seed) 1 -> discount stays WHOLE (10), never scaled to the delivered share (5)", () => {
    // order.subtotal 100 == activeSubtotal 100 -> r_seed 1. deliveredSubtotal
    // 50 -> delivered share 0.5. If the code wrongly applied the DELIVERED
    // share to discount, this would read 5, not 10.
    const due = reconciledAmountDue({
      drafts: [],
      order: { subtotal: 100, tax: 0, discountAmount: 10, shippingFee: 0 },
      activeSubtotal: 100,
      deliveredSubtotal: 50,
      deliveredCategoryTax: 0,
    });
    expect(due).toBe(40); // 50 - 10 + 0 + 0*0.5 + 0
    expect(due).not.toBe(45); // 50 - 5 (wrongly delivered-share-scaled discount)
  });

  it("SA-092b: seeding share (r_seed) 0.5 scales the discount to 5, distinct from the delivered share", () => {
    // activeSubtotal 50 vs order.subtotal 100 -> r_seed 0.5. discount 10 x
    // 0.5 = 5.
    const due = reconciledAmountDue({
      drafts: [],
      order: { subtotal: 100, tax: 0, discountAmount: 10, shippingFee: 0 },
      activeSubtotal: 50,
      deliveredSubtotal: 50,
      deliveredCategoryTax: 0,
    });
    expect(due).toBe(45); // 50 - 5 + 0 + 0 + 0
  });

  it("SA-092b: a draft's own stored discount is used as-is, never re-scaled by r_seed", () => {
    const due = reconciledAmountDue({
      drafts: [{ discount: 10, shippingFee: 0 }],
      order: { subtotal: 100, tax: 0 },
      activeSubtotal: 50, // r_seed 0.5 -- must NOT touch a draft's own discount
      deliveredSubtotal: 50,
      deliveredCategoryTax: 0,
    });
    expect(due).toBe(40); // 50 - 10 (draft's own discount, whole) + 0 + 0 + 0
  });

  it("REG-B305 falls back to the bare delivered subtotal when the order's own subtotal isn't a usable basis", () => {
    expect(
      reconciledAmountDue({
        drafts: [{ discount: 0, shippingFee: 0 }],
        order: { subtotal: 0, tax: 10 },
        deliveredSubtotal: 42,
        deliveredCategoryTax: 0,
      }),
    ).toBe(42);
  });
});

/**
 * REG-B305 round 3 (Opus): the server zeroes BOTH the regular tax term and the
 * per-line category tax for a tax-exempt customer (invoices.service.ts
 * ~1495-1500: `regularTax = isTaxExempt ? 0 : …`, `foldCategoryTax(…,
 * isTaxExempt)` -> 0) — neither `order.tax` nor the delivered lines'
 * `categoryTaxAmount` snapshots are exemption-aware on their own, so the
 * short-pick estimate must be told separately. Before the fix,
 * `reconciledAmountDue` has no `isTaxExempt` input at all and always charges
 * the delivered category tax — exempt + deliver B only quotes 160, the server
 * bills 100 ($60 over-collected at the door).
 */
describe("reconciledAmountDue (REG-B305 round 3: tax-exempt customer)", () => {
  it("REG-B305 round 3 the Opus scenario: exempt customer, deliver B only -> 100, never 160", () => {
    // order subtotal 200, tax (regular) 20; lines A {qty 1, subtotal 100,
    // categoryTaxAmount 0} + B {qty 1, subtotal 100, categoryTaxAmount 50}; one
    // draft {subtotal 200, taxAmount 0, discount 0, shippingFee 0, total 200}
    // (the server already zeroed the draft's own tax for this exempt customer).
    const order = { subtotal: 200, tax: 20 };
    const drafts = [{ discount: 0, shippingFee: 0 }];
    const dueDeliverBOnly = reconciledAmountDue({
      drafts,
      order,
      deliveredSubtotal: 100,
      deliveredCategoryTax: 50,
      isTaxExempt: true,
    });
    expect(dueDeliverBOnly).toBe(100);
    expect(dueDeliverBOnly).not.toBe(160);
  });

  it("REG-B305 round 3: exempt customer keeps discount/shipping fee whole — only the tax terms zero", () => {
    const order = { subtotal: 100, tax: 10 };
    const drafts = [{ discount: 15, shippingFee: 10 }];
    // Deliver half (50), exempt: 50 - 15 + 10 = 45. Non-exempt would add
    // 10 * 50/100 = 5 -> 50 (see the sibling non-exempt discount/fee test above).
    expect(
      reconciledAmountDue({
        drafts,
        order,
        deliveredSubtotal: 50,
        deliveredCategoryTax: 0,
        isTaxExempt: true,
      }),
    ).toBe(45);
  });

  it("REG-B305 round 3: non-exempt is unchanged — the existing A-only/B-only/both oracles stay put", () => {
    const order = { subtotal: 200, tax: 20 };
    const drafts = [{ discount: 0, shippingFee: 0 }];
    expect(
      reconciledAmountDue({ drafts, order, deliveredSubtotal: 100, deliveredCategoryTax: 0 }),
    ).toBe(110);
    expect(
      reconciledAmountDue({ drafts, order, deliveredSubtotal: 100, deliveredCategoryTax: 50 }),
    ).toBe(160);
    expect(
      reconciledAmountDue({ drafts, order, deliveredSubtotal: 200, deliveredCategoryTax: 50 }),
    ).toBe(270);
  });
});

/**
 * REG-B305 round 4: the door quote's two halves — `deliveredSubtotal` and
 * `deliveredCategoryTax` — must be fed from the SAME line set. Round 3's
 * `payment.tsx` built `shortPickLines` (the delivered-subtotal basis) from
 * `order.lineItems` filtered `status !== "CANCELLED" && deliveredQty === 0`,
 * but fed the RAW `order.lineItems` straight into `deliveredCategoryTax` —
 * which defaults a line ABSENT from the delivery plan to fully delivered
 * (matches `buildDeliveries`'s own convention). A cancelled regulated line,
 * or one already delivered on an earlier split-delivery visit, is therefore
 * excluded from the subtotal but still contributes its FULL
 * `categoryTaxAmount` — cash over-collected at the door.
 *
 * These tests assert the INVARIANT (the door amount), never the filter
 * mechanics, and build the fixture the same way `payment.tsx:110-128` does —
 * `buildShortPickLines` below mirrors that mapping exactly (imports the real
 * `ShortPickLine` type, `reconciledTotal`, and `freeUnitSizeFor` from
 * `lib/short-pick`, the same helpers the page uses).
 *
 * Scope: these fixtures pin the DOOR COMPOSITION invariant only. The
 * cancelled-line case's door amount is independently re-derivable as a real
 * invoice total (see its oracle comment below); the split-delivery case is
 * NOT — see that test's own scope note for the standing `rebuildSiblingDrafts`
 * reachability gap it documents instead.
 */
describe("REG-B305 round 4 — the door quote's two halves derive from ONE line set (a cancelled or already-delivered line contributes neither subtotal nor category tax)", () => {
  // Mirrors payment.tsx:110-128's shortPickLines useMemo verbatim, over a
  // fixture shaped like `order.lineItems` (id/productId/qty/subtotal/status/
  // deliveredQty/categoryTaxAmount — a superset of both `ShortPickLine`'s
  // raw material and `RunMoneyLineItem`).
  function buildShortPickLines(
    lines: Array<{
      id: string;
      productId: string;
      qty: number;
      subtotal: number;
      status: string;
      deliveredQty: number;
      boxes?: number | null;
    }>,
  ): ShortPickLine[] {
    return lines
      .filter((li) => li.status !== "CANCELLED" && Number(li.deliveredQty ?? 0) === 0)
      .map((li) => ({
        orderItemId: li.id,
        productId: li.productId,
        orderedQty: Number(li.qty),
        subtotal: li.subtotal ?? null,
        freeUnits: 0,
        freeUnitSize: freeUnitSizeFor(li),
      }));
  }

  it("REG-B305 round 4: a CANCELLED regulated line contributes zero subtotal AND zero category tax (documents the leak it fixes)", () => {
    // Line A: regulated, cancelled, qty 10, subtotal 100, categoryTaxAmount
    // 12.00, deliveredQty 0 (never delivered — just cancelled). Line B: qty 5,
    // subtotal 50, categoryTaxAmount 0. Order columns are already recomputed
    // to exclude the cancelled line (subtotal 50, tax 4.00). One open draft
    // with no discount/fee. Plan short-picks B down to 4.
    const lines = [
      { id: "A", productId: "p-A", qty: 10, subtotal: 100, status: "CANCELLED", deliveredQty: 0 },
      { id: "B", productId: "p-B", qty: 5, subtotal: 50, status: "PENDING", deliveredQty: 0 },
    ];
    const runLines = [
      { id: "A", qty: 10, unitPrice: 10, subtotal: 100, categoryTaxAmount: 12.0 },
      { id: "B", qty: 5, unitPrice: 10, subtotal: 50, categoryTaxAmount: 0 },
    ];
    const order = { subtotal: 50, tax: 4.0 };
    const draftDiscount = 0;
    const draftShippingFee = 0;
    const drafts = [{ discount: draftDiscount, shippingFee: draftShippingFee }];
    const plan = { B: 4 };

    const shortPickLines = buildShortPickLines(lines);
    expect(shortPickLines.map((l) => l.orderItemId)).toEqual(["B"]); // A excluded: cancelled

    // Oracle: invoices.service.ts#reconcileOrderDraftInvoice — regular tax
    // scales by the delivered SHARE of the order's own subtotal; discount and
    // shipping fee on the open draft stay WHOLE. #buildInvoiceItemData —
    // `categoryTaxAmount = stored * billQty / orderQty`, summed only over the
    // lines this visit actually bills (`where status != CANCELLED`, and never
    // a line already fully billed on an earlier visit). This oracle DOES hold
    // as a real server-invoice equality (unlike the split-delivery test
    // below): orders.service.ts's totals recompute (~4481-4492) selects only
    // `status: { not: "CANCELLED" }` lines, so cancelled line A's subtotal
    // and tax never entered `order.subtotal`/`order.tax` (50 / 4.00) to begin
    // with — a reader can re-derive 43.20 from those two columns directly.
    const deliveredSubtotal = reconciledTotal(shortPickLines, plan);
    const regularTax = roundMoney(order.tax * (deliveredSubtotal / order.subtotal));
    // Σ over the visit's delivered lines (B only — A is neither in
    // shortPickLines nor billable) of categoryTaxAmount * delivered / qty.
    const deliveredExcise = shortPickCategoryTax(runLines, shortPickLines, plan);
    const expected = roundMoney(
      deliveredSubtotal - draftDiscount + draftShippingFee + regularTax + deliveredExcise,
    );
    expect(expected).toBe(43.2); // 40 (delivered B) + 4.00 * 0.8 (B's share) + 0 excise

    const actual = reconciledAmountDue({
      drafts,
      order,
      deliveredSubtotal,
      deliveredCategoryTax: deliveredExcise,
      isTaxExempt: false,
    });
    expect(actual).toBe(expected);

    // Documents the defect: the OLD composition fed the RAW runLines straight
    // into deliveredCategoryTax, which defaults A (absent from `plan`) to
    // fully delivered and leaks its whole $12.00 category tax in.
    const leakedExcise = deliveredCategoryTax(runLines, plan);
    const oldExpected = roundMoney(
      deliveredSubtotal - draftDiscount + draftShippingFee + regularTax + leakedExcise,
    );
    expect(oldExpected).toBe(55.2); // 43.20 + A's leaked $12.00
    const oldComposition = reconciledAmountDue({
      drafts,
      order,
      deliveredSubtotal,
      deliveredCategoryTax: leakedExcise,
      isTaxExempt: false,
    });
    expect(oldComposition).toBe(oldExpected);
    expect(oldComposition).not.toBe(actual);
  });

  it("REG-B305 round 4: a regulated line already delivered on an earlier visit contributes zero category tax to the door quote", () => {
    // Line R: regulated, qty 10, subtotal 200, categoryTaxAmount 20.00,
    // deliveredQty 10 (billed on visit 1's invoice already). Line S: qty 4,
    // subtotal 80, categoryTaxAmount 0, deliveredQty 0. Order subtotal 280,
    // tax 14.00. One open draft (the `-R2` split invoice), no discount/fee.
    // Plan short-picks S down to 2.
    const lines = [
      { id: "R", productId: "p-R", qty: 10, subtotal: 200, status: "PENDING", deliveredQty: 10 },
      { id: "S", productId: "p-S", qty: 4, subtotal: 80, status: "PENDING", deliveredQty: 0 },
    ];
    const runLines = [
      { id: "R", qty: 10, unitPrice: 20, subtotal: 200, categoryTaxAmount: 20.0 },
      { id: "S", qty: 4, unitPrice: 20, subtotal: 80, categoryTaxAmount: 0 },
    ];
    const order = { subtotal: 280, tax: 14.0 };
    const draftDiscount = 0;
    const draftShippingFee = 0;
    const drafts = [{ discount: draftDiscount, shippingFee: draftShippingFee }];
    const plan = { S: 2 };

    const shortPickLines = buildShortPickLines(lines);
    expect(shortPickLines.map((l) => l.orderItemId)).toEqual(["S"]); // R excluded: already delivered

    // Same oracles as the test above.
    const deliveredSubtotal = reconciledTotal(shortPickLines, plan);
    const regularTax = roundMoney(order.tax * (deliveredSubtotal / order.subtotal));
    const deliveredExcise = shortPickCategoryTax(runLines, shortPickLines, plan);
    const expected = roundMoney(
      deliveredSubtotal - draftDiscount + draftShippingFee + regularTax + deliveredExcise,
    );
    expect(expected).toBe(42.0); // 40 (delivered S) + 14.00 * (40/280) + 0 excise

    const actual = reconciledAmountDue({
      drafts,
      order,
      deliveredSubtotal,
      deliveredCategoryTax: deliveredExcise,
      isTaxExempt: false,
    });
    expect(actual).toBe(expected);

    // SCOPE NOTE (replaces an earlier "equals what the server invoices"
    // claim — that claim does not hold): this fences the DOOR COMPOSITION
    // only. The server's `rebuildSiblingDrafts` (invoices.service.ts
    // ~1848-1872) bills each line at `billQtyOf = Number(li.deliveredQty)`
    // with NO `priorBilledQty` subtracted, and line R (`deliveredQty: 10`,
    // status PENDING, not CANCELLED) survives its `where status !=
    // CANCELLED` line select — so an actual visit-2 draft rebuild would bill
    // R's subtotal (200) again alongside S's (40), landing at 272.00
    // (240 subtotal + round(14 * 240/280) = 12.00 regular tax + 20.00
    // category tax), not this test's 42.00. No reachable path to that state
    // was found: `deliveredQty > 0` is written only by `completeWithPayment`
    // (which completes the stop), and `reopenStop` zeroes it back out — so
    // it is latent, not live. This fixture documents the composition
    // invariant (both halves derive from `shortPickLines`), not a live
    // invoice equality.
    //
    // TO FILE: partial prior delivery (`0 < deliveredQty < qty`) is excluded
    // from `shortPickLines` entirely (the filter requires `deliveredQty ===
    // 0`), so neither its remaining subtotal nor its remaining excise is
    // quoted at the door — a pre-existing F38 design gap, latent for the
    // same reachability reason as above.

    // Documents the defect: R is absent from `plan` (it was never re-picked
    // this visit), so the OLD raw-lines composition defaults it to fully
    // delivered and re-collects its whole $20.00 category tax a SECOND time.
    const leakedExcise = deliveredCategoryTax(runLines, plan);
    const oldExpected = roundMoney(
      deliveredSubtotal - draftDiscount + draftShippingFee + regularTax + leakedExcise,
    );
    expect(oldExpected).toBe(62.0); // 42.00 + R's re-collected $20.00
    const oldComposition = reconciledAmountDue({
      drafts,
      order,
      deliveredSubtotal,
      deliveredCategoryTax: leakedExcise,
      isTaxExempt: false,
    });
    expect(oldComposition).toBe(oldExpected);
    expect(oldComposition).not.toBe(actual);
  });

  it("REG-B305 round 4 guard: a line absent from shortPickLines contributes zero even with a categoryTaxAmount and a plan entry; a line present in both matches deliveredCategoryTax exactly", () => {
    const runLines = [
      // X is NOT in shortPickLines below (simulates cancelled/already-delivered)
      // yet still carries a categoryTaxAmount AND an entry in the plan.
      { id: "X", qty: 10, unitPrice: 10, subtotal: 100, categoryTaxAmount: 30 },
      { id: "Y", qty: 8, unitPrice: 10, subtotal: 80, categoryTaxAmount: 40 },
    ];
    const shortPickLines: ShortPickLine[] = [
      { orderItemId: "Y", productId: "p-Y", orderedQty: 8, subtotal: 80, freeUnits: 0 },
    ];
    const plan = { X: 5, Y: 3 };

    // X has a plan entry and a nonzero categoryTaxAmount, but is absent from
    // shortPickLines -> must contribute 0, not 30 * 5/10 = 15.
    const restricted = shortPickCategoryTax(runLines, shortPickLines, plan);
    // Y is present in both -> behaves exactly like calling deliveredCategoryTax
    // on the already-restricted (Y-only) line set — same number.
    expect(restricted).toBe(deliveredCategoryTax([runLines[1]], plan));
    expect(restricted).toBe(15); // 40 * 3/8

    // Contrast: the OLD unfiltered composition lets X's leak in too.
    const unfiltered = deliveredCategoryTax(runLines, plan);
    expect(unfiltered).toBe(30); // 15 (X leaked) + 15 (Y)
    expect(restricted).not.toBe(unfiltered);
  });

  it("REG-B305 round 4 guard: a tax-exempt customer zeroes the regular-tax term too (split-visit scenario -> 40.00, never 42.00)", () => {
    const lines = [
      { id: "R", productId: "p-R", qty: 10, subtotal: 200, status: "PENDING", deliveredQty: 10 },
      { id: "S", productId: "p-S", qty: 4, subtotal: 80, status: "PENDING", deliveredQty: 0 },
    ];
    const runLines = [
      { id: "R", qty: 10, unitPrice: 20, subtotal: 200, categoryTaxAmount: 20.0 },
      { id: "S", qty: 4, unitPrice: 20, subtotal: 80, categoryTaxAmount: 0 },
    ];
    const order = { subtotal: 280, tax: 14.0 };
    const draftDiscount = 0;
    const draftShippingFee = 0;
    const drafts = [{ discount: draftDiscount, shippingFee: draftShippingFee }];
    const plan = { S: 2 };

    const shortPickLines = buildShortPickLines(lines);
    const deliveredSubtotal = reconciledTotal(shortPickLines, plan);
    const deliveredExcise = shortPickCategoryTax(runLines, shortPickLines, plan);
    // Oracle: invoices.service.ts ~1495-1500 — an exempt customer zeroes BOTH
    // the regular tax term and the category tax; discount/fee stay whole.
    // This holds regardless of the split-visit reachability caveat above
    // (reused fixture: R already delivered, S short-picked) since exempt
    // zeroes every tax term either way; it is not a claim that 40.00 is what
    // an actual visit-2 invoice would total (see the split test's scope note).
    const expected = roundMoney(deliveredSubtotal - draftDiscount + draftShippingFee);
    expect(expected).toBe(40.0);

    const actual = reconciledAmountDue({
      drafts,
      order,
      deliveredSubtotal,
      deliveredCategoryTax: deliveredExcise,
      isTaxExempt: true,
    });
    expect(actual).toBe(expected);
    expect(actual).not.toBe(42.0);
  });
});
