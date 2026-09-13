/**
 * REG-B49: every driver money figure must derive from the server's box-aware line money,
 * never `qty * unitPrice` for a boxed line (spec R2, test-plan T-B49m). `lib/run-money.ts`
 * does not exist as a real implementation yet — imports resolve against a signature-only
 * stub so these fail on assertion, not on module resolution.
 */
import {
  deliveredCategoryTax,
  lineItemSubtotal,
  orderAmountDue,
  reconciledAmountDue,
  shortPickCategoryTax,
  stopAmountDue,
  sumOrderLineItems,
  sumStopOrders,
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
 * amount due must be the order's OPEN DRAFT INVOICE as the server last
 * computed it (`order.invoices[0]`: `total = subtotal + taxAmount +
 * shippingFee - discount`). These fixtures pin that basis; before the fix,
 * `orderAmountDue`/`reconciledAmountDue` read `order.total` directly and the
 * discount/split-fee assertions below are red on the WRONG (pre-fix) value,
 * not on a missing export.
 */
describe("REG-B305 tax-inclusive amount due (round 2: read off the draft invoice)", () => {
  it("REG-B305 the bug's own numbers: quotes and collects the draft invoice's total", () => {
    const order = {
      lineItems: [{ qty: 1, unitPrice: 116.83, subtotal: 116.83 }],
      invoices: [
        {
          id: "inv-1",
          subtotal: "116.83",
          taxAmount: "11.68",
          discount: "0",
          shippingFee: "0",
          total: "128.51",
        },
      ],
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
      invoices: [
        { id: "inv-1", subtotal: 100, taxAmount: 10, discount: 15, shippingFee: 0, total: 95 },
      ],
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
      invoices: [
        { id: "inv-1", subtotal: 50, taxAmount: 5, discount: 0, shippingFee: 10, total: 65 },
      ],
    };
    expect(orderAmountDue(firstVisit as any)).toBe(65);
    const secondVisit = {
      ...baseOrder,
      invoices: [
        { id: "inv-2", subtotal: 50, taxAmount: 5, discount: 0, shippingFee: 0, total: 55 },
      ],
    };
    expect(orderAmountDue(secondVisit as any)).toBe(55);
    expect(orderAmountDue(secondVisit as any)).not.toBe(121);
  });

  it("REG-B305 RULING 1: sums ALL open drafts, not just the first (a regulated split can have several)", () => {
    const order = {
      lineItems: [],
      invoices: [
        { id: "base", subtotal: 60, taxAmount: 0, discount: 0, shippingFee: 0, total: 120 },
        { id: "base-R1", subtotal: 40, taxAmount: 0, discount: 0, shippingFee: 0, total: 80 },
      ],
    };
    expect(orderAmountDue(order as any)).toBe(200);
  });

  it("REG-B305 without an open draft the amount due falls back to the pre-tax line sum, never a client-side discount guess", () => {
    // Order.total (110) and discountAmount (15) look like they'd net to 95, but
    // Order.total is only net-of-discount on the CREATE path — an edited/merged
    // order can leave it stale, so re-deriving the discount client-side is never
    // safe (RULING 2). No `invoices` at all -> the honest pre-tax line sum (100).
    const order = {
      lineItems: [{ qty: 2, unitPrice: 50, subtotal: 100 }],
      total: 110,
      discountAmount: 15,
    };
    expect(orderAmountDue(order as any)).toBe(sumOrderLineItems(order as any));
    expect(orderAmountDue(order as any)).toBe(100);
    expect(orderAmountDue(order as any)).not.toBe(95);
  });

  it("REG-B305 falls back to the pre-tax line sum when the payload carries no total at all", () => {
    const order = { lineItems: [{ qty: 2, unitPrice: 10, subtotal: 20 }] };
    expect(orderAmountDue(order as any)).toBe(sumOrderLineItems(order as any));
  });

  it("REG-B305 a malformed total with no draft falls to the line sum, never NaN", () => {
    const order = { lineItems: [{ qty: 2, unitPrice: 10, subtotal: 20 }], total: "abc" };
    const due = orderAmountDue(order as any);
    expect(due).toBe(20);
    expect(Number.isNaN(due)).toBe(false);
  });

  it("REG-B305 coerces string-Decimal draft totals", () => {
    const base = { lineItems: [{ qty: 1, unitPrice: 10, subtotal: 10 }] };
    expect(
      orderAmountDue({
        ...base,
        invoices: [
          {
            id: "i1",
            subtotal: "10",
            taxAmount: "0",
            discount: "0",
            shippingFee: "0",
            total: "10",
          },
        ],
      } as any),
    ).toBe(10);
  });

  it("REG-B305 stopAmountDue mixes a draft-bearing order with a legacy order, never NaN", () => {
    const draftOrder = {
      lineItems: [],
      invoices: [{ id: "i1", subtotal: 50, taxAmount: 5, discount: 0, shippingFee: 0, total: 55 }],
    };
    const legacyOrder = { lineItems: [{ qty: 1, unitPrice: 20, subtotal: 20 }] };
    // No draft AND a malformed total -> falls all the way to the line sum.
    const brokenOrder = { lineItems: [{ qty: 1, unitPrice: 5, subtotal: 5 }], total: "garbage" };
    expect(stopAmountDue({ orders: [draftOrder, legacyOrder, brokenOrder] } as any)).toBe(80);
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

  it("REG-B305 falls back to the bare delivered subtotal (legacy) when the payload carries no open draft", () => {
    expect(
      reconciledAmountDue({
        drafts: [],
        order: { subtotal: 100, tax: 10 },
        deliveredSubtotal: 42,
        deliveredCategoryTax: 5,
      }),
    ).toBe(42);
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
