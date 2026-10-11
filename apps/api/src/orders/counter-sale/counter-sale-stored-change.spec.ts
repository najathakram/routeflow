import { legGroupId } from "./counter-tender-row";
import { servedChange } from "./counter-sale-readback";

/**
 * SA-764 + SA-749r2: the change every surface shows is ONE function (pricing's `counterChange`) of the stored cash
 * handed over, the sale's total and what the NON-cash methods applied. The first tender being CASH is not a condition:
 * a card-first split serves change.
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
    expect(servedChange(ORDER, null, [pay(41.27)])).toBeNull();
    expect(servedChange(ORDER, undefined, [pay(41.27)])).toBeNull();
  });

  it("is null when the sale has no CASH tender row (a card-only sale, whatever stale tendered is stored)", () => {
    expect(servedChange(ORDER, "50.00", [])).toBeNull();
    expect(servedChange(ORDER, 50, [pay(41.27, "CREDIT_CARD")])).toBeNull();
    expect(servedChange(ORDER, 50, [pay(41.27, "CHECK")])).toBeNull();
    expect(servedChange(ORDER, 50, [pay(30, "CASH", "VOID")])).toBeNull();
  });

  it("a single cash leg: the stored tendered less the total, to the cent (byte-for-byte what master served)", () => {
    expect(servedChange(ORDER, "50.00", [pay(41.27)])).toBe(8.73);
    expect(servedChange(ORDER, 60, [pay(41.27)])).toBe(18.73);
    expect(servedChange(ORDER, 41.27, [pay(41.27)])).toBe(0);
  });

  it("a credit-note / advance application is non-cash money: it lowers the cash the sale took", () => {
    expect(servedChange(ORDER, 50, [pay(5, "CREDIT_NOTE"), pay(36.27)])).toBe(13.73);
    expect(servedChange(ORDER, 50, [pay(5, "CREDIT_NOTE"), pay(7, "ADVANCE")])).toBeNull();
  });

  it("a CARD-FIRST split serves change: card 30 + cash handed 50 on a 70 sale, change 10", () => {
    const rows = [leg(0, 30, "CREDIT_CARD"), leg(1, 40)];
    expect(servedChange(ORDER, 50, rows)).toBe(10);
  });

  it("a cash-first split serves the same change whatever order the rows are listed in", () => {
    const rows = [leg(0, 40), leg(1, 30, "CREDIT_CARD")];
    expect(servedChange(ORDER, 50, rows)).toBe(10);
    expect(servedChange(ORDER, 50, [...rows].reverse())).toBe(10);
  });

  it("card 30 + cash handed 40 on a 50 sale: cash took 20, change 20", () => {
    expect(servedChange(ORDER, 40, [leg(0, 30, "CREDIT_CARD"), leg(1, 20)])).toBe(20);
  });

  it("exact cash is a Change 0 row, not null", () => {
    expect(servedChange(ORDER, 40, [leg(0, 30, "CREDIT_CARD"), leg(1, 40)])).toBe(0);
  });

  it("a partly paid sale whose cash all went in serves Change 0 (no balance gate: the change is the stored rows' alone)", () => {
    expect(servedChange(ORDER, "20.00", [pay(20)])).toBe(0);
  });

  it("never serves a negative change", () => {
    expect(servedChange(ORDER, 10, [pay(41.27)])).toBe(0);
  });

  // S1: the change is measured against the sale's STORED cash row(s), so nothing that happens to the other rows or to the
  // total afterwards can move a past sale's change.
  it("S1 card 30 + cash handed 40 on 50: the card row voided later, the change stays 20", () => {
    const rows = [leg(0, 30, "CREDIT_CARD"), leg(1, 20)];
    expect(servedChange(ORDER, 40, rows)).toBe(20);
    const afterVoid = [leg(0, 30, "CREDIT_CARD", "VOID"), leg(1, 20)];
    expect(servedChange(ORDER, 40, afterVoid)).toBe(20);
  });

  it("S1 a single cash sale of 50 paid with 60 handed: the change is the stored row's (10), whatever the total becomes", () => {
    // servedChange takes no total: a later cut of the order total (50 -> 45) can not reach it
    expect(servedChange(ORDER, 60, [pay(50)])).toBe(10);
  });
});
