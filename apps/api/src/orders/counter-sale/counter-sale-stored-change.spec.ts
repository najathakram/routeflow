import { isCounterTenderCashRow, servedChange, storedChange } from "./counter-sale-readback";

/**
 * SA-764: the change a reprint shows is a pure function of the stored tendered amount and the sale's OWN
 * original counter-tender CASH rows, so a credit-note / advance application can never move it.
 */
const pay = (amount: number, method = "CASH", status = "PAID") => ({ amount, method, status });

describe("storedChange (SA-764)", () => {
  it("is null when nothing was tendered", () => {
    expect(storedChange(null, [pay(41.27)])).toBeNull();
    expect(storedChange(undefined, [pay(41.27)])).toBeNull();
  });

  it("is null when no CASH tender row exists", () => {
    expect(storedChange("50.00", [])).toBeNull();
    expect(storedChange(50, [pay(41.27, "CREDIT_CARD")])).toBeNull();
  });

  it("is the stored tendered less the CASH rows, to the cent", () => {
    expect(storedChange("50.00", [pay(41.27)])).toBe(8.73);
    expect(storedChange(60, [pay(41.27)])).toBe(18.73);
    expect(storedChange(41.27, [pay(41.27)])).toBe(0);
  });

  it("never counts a CREDIT_NOTE, ADVANCE or VOID row", () => {
    const rows = [pay(41.27), pay(5, "CREDIT_NOTE"), pay(7, "ADVANCE"), pay(30, "CASH", "VOID")];
    expect(storedChange(50, rows)).toBe(8.73);
    expect(storedChange(50, [pay(5, "CREDIT_NOTE"), pay(7, "ADVANCE")])).toBeNull();
    expect(storedChange(50, [pay(30, "CASH", "VOID")])).toBeNull();
  });

  it("a card + cash mix counts only the cash rows", () => {
    expect(storedChange(20, [pay(21.27, "CREDIT_CARD"), pay(20, "CASH")])).toBe(0);
    expect(storedChange(25, [pay(21.27, "CREDIT_CARD"), pay(20, "CASH")])).toBe(5);
  });

  it("never serves a negative change: cash above the stored tendered reads null (SA-764 N2)", () => {
    expect(storedChange(10, [pay(41.27)])).toBeNull();
    // a later invoice-screen CASH payment on the same sale pushes the cash total past the tendered
    expect(storedChange(50, [pay(41.27), pay(20)])).toBeNull();
    // exactly the tendered is zero change, not null
    expect(storedChange(61.27, [pay(41.27), pay(20)])).toBe(0);
  });

  it("a non-VOID, non-PAID cash row anchors the tender but sums as 0 (sumConfirmed counts PAID only)", () => {
    // observed: the DRAFT row is a counter-tender CASH row (isCounterTenderCashRow) yet adds nothing to the cash
    // total, so the change reads as the whole stored tendered
    expect(storedChange(50, [pay(41.27, "CASH", "DRAFT")])).toBe(50);
    expect(storedChange(50, [pay(41.27), pay(10, "CASH", "DRAFT")])).toBe(8.73);
  });
});

describe("isCounterTenderCashRow (SA-764)", () => {
  it("is a CASH row that is neither VOID nor a credit-note / advance application", () => {
    expect(isCounterTenderCashRow(pay(1))).toBe(true);
    expect(isCounterTenderCashRow(pay(1, "CASH", "DRAFT"))).toBe(true);
    expect(isCounterTenderCashRow(pay(1, "CASH", "VOID"))).toBe(false);
    expect(isCounterTenderCashRow(pay(1, "CREDIT_CARD"))).toBe(false);
    expect(isCounterTenderCashRow(pay(1, "CREDIT_NOTE"))).toBe(false);
    expect(isCounterTenderCashRow(pay(1, "ADVANCE"))).toBe(false);
  });
});

describe("servedChange (SA-764 N3/N4): the ONE gate for POST, by-key and the Today row", () => {
  it("serves the stored change only for a CASH-first sale with nothing left to pay", () => {
    expect(servedChange("50.00", [pay(41.27)], 0)).toBe(8.73);
  });

  it("is null while balance remains (a partly paid cash sale)", () => {
    expect(servedChange("50.00", [pay(20)], 21.27)).toBeNull();
  });

  it("is null when the first stored tender is not CASH, whatever stale tendered is stored", () => {
    expect(servedChange(50, [pay(41.27, "CREDIT_CARD")], 0)).toBeNull();
    expect(servedChange(50, [pay(21.27, "CREDIT_CARD"), pay(20)], 0)).toBeNull();
    expect(servedChange(50, [pay(41.27, "CHECK")], 0)).toBeNull();
  });

  it("skips credit-note / advance rows when finding the first tender", () => {
    expect(servedChange(50, [pay(5, "CREDIT_NOTE"), pay(36.27)], 0)).toBe(13.73);
  });

  it("is null for a CASH sale with a cash row but NO stored tendered (legacy): no fallback", () => {
    expect(servedChange(null, [pay(41.27)], 0)).toBeNull();
    expect(servedChange(undefined, [pay(41.27)], 0)).toBeNull();
  });

  it("is null when the stored change would be negative", () => {
    expect(servedChange(10, [pay(41.27)], 0)).toBeNull();
  });
});
