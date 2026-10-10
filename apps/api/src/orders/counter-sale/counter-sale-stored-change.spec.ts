import { storedChange } from "./counter-sale-readback";

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

  it("does not clamp: cash short of the stored tendered is simply negative", () => {
    expect(storedChange(10, [pay(41.27)])).toBe(-31.27);
  });
});
