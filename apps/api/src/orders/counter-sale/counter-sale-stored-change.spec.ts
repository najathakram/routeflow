import { legGroupId } from "./counter-tender-row";
import { servedChange } from "./counter-sale-readback";

/**
 * SA-764 + SA-749r2: the change every surface shows is ONE function (pricing's `counterChange`) of the stored cash
 * handed over and the sale's own stored CASH rows. The first tender being CASH is not a condition: a card-first split
 * serves change. A positive change needs the tender to have COMPLETED at the time (voided rows count toward that), so an
 * interrupted tender serves none.
 */
const ORDER = "11111111-1111-4111-8111-111111111111";
const pay = (
  amount: number,
  method = "CASH",
  status = "PAID",
  paymentGroupId: string | null = null,
) => ({ amount, method, status, paymentGroupId });
const leg = (i: number, amount: number, method = "CASH", status = "PAID") =>
  pay(amount, method, status, legGroupId(ORDER, i));

describe("servedChange (SA-764 + SA-749r2): the ONE gate for POST, by-key, Today's row and the receipt", () => {
  it("is null when nothing was tendered", () => {
    expect(servedChange(ORDER, null, [pay(41.27)], 41.27)).toBeNull();
    expect(servedChange(ORDER, undefined, [pay(41.27)], 41.27)).toBeNull();
  });

  it("is null when the sale has no CASH tender row (a card-only sale, whatever stale tendered is stored)", () => {
    expect(servedChange(ORDER, "50.00", [], 41.27)).toBeNull();
    expect(servedChange(ORDER, 50, [pay(41.27, "CREDIT_CARD")], 41.27)).toBeNull();
    expect(servedChange(ORDER, 50, [pay(41.27, "CHECK")], 41.27)).toBeNull();
    expect(servedChange(ORDER, 50, [pay(30, "CASH", "VOID")], 41.27)).toBeNull();
  });

  it("a single cash leg: the stored tendered less the cash row, to the cent (what master served)", () => {
    expect(servedChange(ORDER, "50.00", [pay(41.27)], 41.27)).toBe(8.73);
    expect(servedChange(ORDER, 60, [pay(41.27)], 41.27)).toBe(18.73);
    expect(servedChange(ORDER, 41.27, [pay(41.27)], 41.27)).toBe(0);
  });

  it("a credit-note / advance application is credit taken up front: the cash row is what is measured", () => {
    expect(servedChange(ORDER, 50, [pay(5, "CREDIT_NOTE"), pay(36.27)], 41.27)).toBe(13.73);
    expect(servedChange(ORDER, 50, [pay(5, "CREDIT_NOTE"), pay(7, "ADVANCE")], 41.27)).toBeNull();
  });

  it("a CARD-FIRST split serves change: card 30 + cash handed 50 on a 70 sale, change 10", () => {
    expect(servedChange(ORDER, 50, [leg(0, 30, "CREDIT_CARD"), leg(1, 40)], 70)).toBe(10);
  });

  it("a cash-first split serves the same change whatever order the rows are listed in", () => {
    const rows = [leg(0, 40), leg(1, 30, "CREDIT_CARD")];
    expect(servedChange(ORDER, 50, rows, 70)).toBe(10);
    expect(servedChange(ORDER, 50, [...rows].reverse(), 70)).toBe(10);
  });

  it("card 30 + cash handed 40 on a 50 sale: cash took 20, change 20", () => {
    expect(servedChange(ORDER, 40, [leg(0, 30, "CREDIT_CARD"), leg(1, 20)], 50)).toBe(20);
  });

  it("exact cash is a Change 0 row, not null", () => {
    expect(servedChange(ORDER, 40, [leg(0, 30, "CREDIT_CARD"), leg(1, 40)], 70)).toBe(0);
  });

  it("a partly paid sale whose cash all went in serves Change 0 (no balance gate for a zero)", () => {
    expect(servedChange(ORDER, "20.00", [pay(20)], 41.27)).toBe(0);
  });

  it("never serves a negative change", () => {
    expect(servedChange(ORDER, 10, [pay(41.27)], 41.27)).toBe(0);
  });

  // S1: measured against the STORED cash row(s), and a completed tender stays completed.
  it("S1 card 30 + cash handed 40 on 50: the card row voided later, the change stays 20", () => {
    expect(servedChange(ORDER, 40, [leg(0, 30, "CREDIT_CARD"), leg(1, 20)], 50)).toBe(20);
    expect(servedChange(ORDER, 40, [leg(0, 30, "CREDIT_CARD", "VOID"), leg(1, 20)], 50)).toBe(20);
  });

  it("S1 a cash sale of 50 paid with 60 handed: a later total cut to 45 leaves the change 10", () => {
    expect(servedChange(ORDER, 60, [pay(50)], 50)).toBe(10);
    expect(servedChange(ORDER, 60, [pay(50)], 45)).toBe(10);
  });

  // SHOULD 1: an interrupted tender is money still owed, not change.
  it("an interrupted cash leg (20 of 50 recorded, 50 handed over) serves null", () => {
    expect(servedChange(ORDER, 50, [leg(0, 20)], 50)).toBeNull();
  });

  it("an interrupted split (card 30 recorded, cash row missing is not even a cash row) serves null", () => {
    expect(servedChange(ORDER, 40, [leg(0, 30, "CREDIT_CARD")], 50)).toBeNull();
    // card 30 + a part-written cash leg 10 of 20 on a 50 sale
    expect(servedChange(ORDER, 40, [leg(0, 30, "CREDIT_CARD"), leg(1, 10)], 50)).toBeNull();
  });

  it("a voided leg of an interrupted tender does not complete it", () => {
    expect(servedChange(ORDER, 50, [leg(0, 20), leg(0, 5, "CASH", "VOID")], 50)).toBeNull();
  });

  it("a completed tender whose every other row was voided still counts as completed", () => {
    expect(servedChange(ORDER, 40, [leg(0, 30, "CREDIT_CARD", "VOID"), leg(1, 20)], 45)).toBe(20);
  });
});
