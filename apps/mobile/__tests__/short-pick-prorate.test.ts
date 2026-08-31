/**
 * REG-B50 (T-B50, spec R5): `reconciledTotal` — the short-pick screen's at-door
 * ESTIMATE — must prorate a BUY_N_GET_M line on the server's PAID-basis floored
 * cumulative telescope, never the current LINEAR (delivered/ordered) proration.
 * Reference oracle: `apps/api/src/invoices/invoices.service.ts:827-897`
 * (`buildInvoiceItemData`, untouched by this batch — F03's lane).
 *
 * Register's worked line: unitPrice $10, qty 6, freeUnits 1 (BUY_5_GET_1) ⇒
 * stored subtotal $50 (the 5 PAID units, $10 each — computeLineSubtotal(10, 6,
 * freeUnits:1) = 10 * (6-1) = 50). Expected values are hand-worked from the
 * paid-basis telescope, never read out of the implementation:
 *   paidDelivered(d) = d - floor(d * freeUnits / orderedQty)
 *   charge(d)         = roundMoney(stored * paidDelivered(d) / (orderedQty - freeUnits))
 *   d=5: floor(5*1/6)=floor(0.833)=0 -> paid=5 -> 50 * 5/5 = 50.00
 *   d=3: floor(3*1/6)=floor(0.5)  =0 -> paid=3 -> 50 * 3/5 = 30.00
 *
 * Today `ShortPickLine`/`reconciledTotal` carry no `freeUnits` field at all, so
 * the line's promo is silently ignored and the plain linear formula
 * (stored * delivered / orderedQty) runs instead:
 *   d=5: 50 * 5/6 = 41.67   (register: should be 50.00)
 *   d=3: 50 * 3/6 = 25.00   (register: should be 30.00)
 * — both read RED against the pinned expectations below.
 *
 * `freeUnits` is typed here via a local intersection, not by editing
 * `ShortPickLine` (that's the P3 caller fix's job) — the object still carries
 * the real property at runtime, so once the fix reads `li.freeUnits` this file
 * needs no changes.
 */
import { freeUnitSizeFor, reconciledTotal, type ShortPickLine } from "../lib/short-pick";

type BogoPickLine = ShortPickLine & { freeUnits: number };

const bogoLine = (freeUnits: number): BogoPickLine[] => [
  { orderItemId: "li-bogo", productId: "p-1", orderedQty: 6, subtotal: 50, freeUnits },
];

describe("reconciledTotal — REG-B50 BUY_N_GET_M paid-basis telescope", () => {
  it("REG-B50: 5 of 6 delivered (1 free unit) bills the paid-basis $50.00, not linear $41.67", () => {
    expect(reconciledTotal(bogoLine(1), { "li-bogo": 5 })).toBe(50);
  });

  it("REG-B50: 3 of 6 delivered (1 free unit) bills the paid-basis $30.00, not linear $25.00", () => {
    expect(reconciledTotal(bogoLine(1), { "li-bogo": 3 })).toBe(30);
  });
});

/**
 * The axis trap the driver screens actually hit: `OrderItem.promoFreeUnits`
 * counts whole SELLING units — BOXES on a box-split line — while `qty`, the
 * delivery plan and the qty steppers are all in PIECES. The oracle bridges
 * them with `freeUnitSize` (invoices.service.ts:858), so the screens must pass
 * it too or a boxed BOGO partial under-bills at the door.
 */
describe("reconciledTotal — REG-B50 box-split line (free units are BOXES, qty is PIECES)", () => {
  // 6 boxes of a 24-pack @ $120/box, BUY_1_GET_1 -> 3 free boxes, so the stored
  // subtotal is 120 * (6 - 3) = $360 and the line's qty is 144 pieces.
  const boxedLine: ShortPickLine[] = [
    {
      orderItemId: "li-boxed",
      productId: "p-2",
      orderedQty: 144,
      subtotal: 360,
      freeUnits: 3,
      freeUnitSize: 24,
    },
  ];

  it("REG-B50: 3 of 6 boxes (72 of 144 pieces) bills the server's $240.00, not $181.28", () => {
    // freeUnitSize=24 -> paidQty=144-72=72; freeUnitsThrough(72)=min(3,floor(3*72/144))=1;
    // billedThrough(72)=72-24=48; 360 * 48/72 = 240.00. Treating the 3 free BOXES as
    // 3 free PIECES instead gives 360 * 71/141 = 181.28.
    expect(reconciledTotal(boxedLine, { "li-boxed": 72 })).toBe(240);
  });

  it("REG-B50: a full delivery still copies the stored subtotal verbatim", () => {
    expect(reconciledTotal(boxedLine, {})).toBe(360);
  });
});

describe("freeUnitSizeFor — the axis bridge both driver screens derive", () => {
  it("REG-B50: a box-split line reports its SALE-TIME unitsPerBox, not the live product's", () => {
    expect(freeUnitSizeFor({ boxes: 6, unitsPerBox: 24, product: { unitsPerBox: 12 } })).toBe(24);
  });

  it("falls back to the live product for legacy lines with no snapshot", () => {
    expect(freeUnitSizeFor({ boxes: 6, product: { unitsPerBox: 24 } })).toBe(24);
  });

  it("a selling-unit line (boxes null) keeps both axes identical: 1", () => {
    expect(freeUnitSizeFor({ boxes: null, product: { unitsPerBox: 24 } })).toBe(1);
  });
});

describe("reconciledTotal — no-promo control (must not regress)", () => {
  it("freeUnits 0 stays linear: 3 of 6 delivered bills $25.00 unchanged", () => {
    // Same stored subtotal/qty shape as the BOGO line above, but freeUnits 0 —
    // the paid-basis telescope degenerates to the existing linear formula
    // (paidDelivered(d) = d - floor(d*0/6) = d; denominator orderedQty-0 = 6),
    // so this must read the SAME before and after the fix. A fix that also
    // moves this number is over-correcting.
    expect(reconciledTotal(bogoLine(0), { "li-bogo": 3 })).toBe(25);
  });
});
