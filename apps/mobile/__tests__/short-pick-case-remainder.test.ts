/**
 * SA-175 review of PR #2060 (B785/SA-116) — two real defects, both money/usability-critical:
 *
 * FIX 6: the whole-Case stepper bounded itself with `Math.round(remaining/unitsPerBox)`. A
 * REMAINING qty on a second visit is not always an exact multiple of the Case size — with 5
 * pieces left of a 12-piece Case, `Math.round` gives 0, so the stepper shows "0 of 0" with BOTH
 * buttons disabled: the driver cannot mark the line short OR refused at all. With 30 left of 12,
 * `Math.round` gives 3 (36 pieces), so "+" can send 36 — MORE than the 30 that actually remain,
 * which the server's own fit check then refuses at submit.
 *
 * FIX 7: the remaining-money estimate priced the FIRST `remaining` pieces
 * (`prorateLineSubtotal(subtotal, remaining, qty, ...)`), not "what's still owed" —
 * `prorateLineSubtotal`'s BOGO/free-unit curve is a floored cumulative telescope, not linear, so
 * pricing pieces [0, remaining) is NOT the same as pricing pieces [soFar, qty) when a free unit's
 * threshold falls between them. The correct remaining money is the marginal tail:
 * `prorate(qty, qty) - prorate(soFar, qty)`.
 */
import {
  caseStepperCasesDelivered,
  caseStepperDecrement,
  caseStepperIncrement,
  caseStepperRemainderPieces,
  shortPickLinesFromOrder,
} from "../lib/short-pick";

describe("FIX 6 — caseStepperRemainderPieces / caseStepperCasesDelivered", () => {
  it("5 of 12: 0 whole Cases, 5 pieces left over", () => {
    expect(caseStepperRemainderPieces(5, 12)).toBe(5);
    expect(caseStepperCasesDelivered(5, 5, 12)).toBe(0); // untouched (qty === ordered)
  });

  it("30 of 12: 2 whole Cases, 6 pieces left over", () => {
    expect(caseStepperRemainderPieces(30, 12)).toBe(6);
    expect(caseStepperCasesDelivered(30, 30, 12)).toBe(2);
  });

  it("24 of 12 (an exact multiple): 2 whole Cases, 0 left over", () => {
    expect(caseStepperRemainderPieces(24, 12)).toBe(0);
    expect(caseStepperCasesDelivered(24, 24, 12)).toBe(2);
  });
});

describe("FIX 6 — caseStepperDecrement / caseStepperIncrement never exceed `ordered`", () => {
  it("5 of 12: minus reaches 0 (the driver can refuse), plus caps at 5 (never overshoots)", () => {
    // OLD CODE (pinned failure): the row disabled "−" via `casesDelivered <= 0`, where
    // casesDelivered = Math.round(5/12) = 0 — already 0, so the driver could never press it.
    // The pure decrement function itself must reach 0 directly from the untouched (full) state.
    expect(caseStepperDecrement(5, 5, 12)).toBe(0);
    expect(caseStepperIncrement(0, 5, 12)).toBe(5);
    // Idempotent at both ends — pressing past a bound never moves further.
    expect(caseStepperDecrement(0, 5, 12)).toBe(0);
    expect(caseStepperIncrement(5, 5, 12)).toBe(5);
  });

  it("30 of 12: plus from 24 (2 whole Cases) gives exactly 30, never 36", () => {
    // OLD CODE (pinned failure): Math.round(30/12) = 3, so "+" computed
    // Math.min(3, casesDelivered+1) * 12 = 36 once casesDelivered reached 2 — 6 pieces more
    // than the 30 that actually remain.
    expect(caseStepperIncrement(24, 30, 12)).toBe(30);
    expect(caseStepperIncrement(24, 30, 12)).not.toBe(36);
  });

  it("30 of 12: the full descent from 30 reaches exactly 0, never negative, never skipping past 0", () => {
    let qty = 30;
    const seen: number[] = [qty];
    for (let i = 0; i < 6; i++) {
      qty = caseStepperDecrement(qty, 30, 12);
      seen.push(qty);
    }
    expect(seen[seen.length - 1]).toBe(0);
    expect(seen.every((n) => n >= 0 && n <= 30)).toBe(true);
  });

  it("a whole-Case case (24 of 12, no remainder) steps in plain 12s, unchanged from before", () => {
    expect(caseStepperIncrement(12, 24, 12)).toBe(24);
    expect(caseStepperDecrement(24, 24, 12)).toBe(12);
    expect(caseStepperDecrement(12, 24, 12)).toBe(0);
  });

  it("unitsPerBox <= 0 never divides by zero (degenerate guard)", () => {
    expect(caseStepperRemainderPieces(10, 0)).toBe(0);
    expect(caseStepperCasesDelivered(10, 10, 0)).toBe(0);
    expect(caseStepperDecrement(10, 10, 0)).toBe(0);
    expect(caseStepperIncrement(0, 10, 0)).toBe(10);
  });
});

describe("FIX 6 — shortPickLinesFromOrder carries the real boxes/pieces split on a second visit", () => {
  const caseLine = {
    id: "li-case",
    productId: "p-1",
    status: "PENDING",
    qty: 60, // 5 Cases of 12
    deliveredQty: 41, // 41 delivered at THIS visit's evidence read is irrelevant; soFar governs
    subtotal: 120,
    boxes: 5,
    unitsPerBox: 12,
    unitLabel: "Case",
  };

  it("5 of 12 remaining: boxes=0, pieces=5", () => {
    // soFar=55 leaves 5 remaining (60-55).
    const [line] = shortPickLinesFromOrder(
      { lineItems: [caseLine] },
      { "li-case": 5 },
      { "li-case": 55 },
    );
    expect(line!.orderedQty).toBe(5);
    expect(line!.boxes).toBe(0);
    expect(line!.pieces).toBe(5);
  });

  it("30 of 12 remaining: boxes=2, pieces=6", () => {
    // soFar=30 leaves 30 remaining (60-30).
    const [line] = shortPickLinesFromOrder(
      { lineItems: [caseLine] },
      { "li-case": 30 },
      { "li-case": 30 },
    );
    expect(line!.orderedQty).toBe(30);
    expect(line!.boxes).toBe(2);
    expect(line!.pieces).toBe(6);
  });

  it("an exact-multiple remainder (24 of 12) still reports pieces=0", () => {
    // soFar=36 leaves 24 remaining (60-36).
    const [line] = shortPickLinesFromOrder(
      { lineItems: [caseLine] },
      { "li-case": 24 },
      { "li-case": 36 },
    );
    expect(line!.orderedQty).toBe(24);
    expect(line!.boxes).toBe(2);
    expect(line!.pieces).toBe(0);
  });

  it("a first visit (no soFar) reports the stored split with pieces=0", () => {
    const [line] = shortPickLinesFromOrder(
      { lineItems: [{ ...caseLine, deliveredQty: 0 }] },
      { "li-case": 60 },
    );
    expect(line!.orderedQty).toBe(60);
    expect(line!.boxes).toBe(5);
    expect(line!.pieces).toBe(0);
  });
});

describe("FIX 7 — remaining money is the marginal telescope tail, not a fresh front-slice price", () => {
  // Order of 10 pieces, ONE free unit (BOGO-style, size 1), stored subtotal $100.
  // prorateLineSubtotal's floored free-unit allocation only unlocks the free unit at FULL
  // delivery here (floor(1*cumQty/10) >= 1 only once cumQty >= 10) — so the free unit's entire
  // ~$11.11 discount is concentrated in the LAST stretch of delivery, not spread evenly.
  const promoLine = {
    id: "li-promo",
    productId: "p-2",
    status: "PENDING",
    qty: 10,
    deliveredQty: 8, // irrelevant to the fix; soFar governs the remaining view
    subtotal: 100,
    promoFreeUnits: 1,
  };

  it("8 of 10 already delivered at another visit: remaining money is the TAIL price ($11.11), not the front-slice price of 2 units ($22.22)", () => {
    const [line] = shortPickLinesFromOrder(
      { lineItems: [promoLine] },
      { "li-promo": 2 },
      { "li-promo": 8 },
    );
    expect(line!.orderedQty).toBe(2);
    // The old bug (pricing the front 2 pieces out of 10) would have produced 22.22.
    expect(line!.subtotal).not.toBe(22.22);
    expect(line!.subtotal).toBe(11.11);
  });

  it("a first visit (no soFar) is unaffected — full stored subtotal, untouched", () => {
    const [line] = shortPickLinesFromOrder(
      { lineItems: [{ ...promoLine, deliveredQty: 0 }] },
      { "li-promo": 10 },
    );
    expect(line!.orderedQty).toBe(10);
    expect(line!.subtotal).toBe(100);
  });

  it("a non-promo line (freeUnits 0) is unaffected by the formula change — linear, both ways agree", () => {
    const plain = { ...promoLine, promoFreeUnits: 0 };
    const [line] = shortPickLinesFromOrder(
      { lineItems: [plain] },
      { "li-promo": 2 },
      { "li-promo": 8 },
    );
    expect(line!.orderedQty).toBe(2);
    expect(line!.subtotal).toBe(20); // 2 of 10 pieces at $10/piece, no promo distortion
  });
});
