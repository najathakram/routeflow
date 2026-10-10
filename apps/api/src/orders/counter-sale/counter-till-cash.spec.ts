import { isTillCashRow } from "./counter-till-cash";

/** SA-750r3 amended: the ONE predicate for "this payment row is CASH in the till drawer". */
describe("isTillCashRow", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    method: "CASH",
    status: "PAID",
    paymentGroupId: null,
    checkStatus: null,
    ...over,
  });

  it.each([
    ["an ungrouped PAID CASH row", row(), true],
    ["an ungrouped PENDING CASH row", row({ status: "PENDING" }), true],
    ["a CHECK", row({ method: "CHECK", checkStatus: "RECORDED" }), false],
    ["a CREDIT_CARD", row({ method: "CREDIT_CARD" }), false],
    ["an ACH", row({ method: "ACH" }), false],
    ["a CREDIT_NOTE application", row({ method: "CREDIT_NOTE" }), false],
    ["a VOID CASH row", row({ status: "VOID" }), false],
    ["a DRAFT CASH row", row({ status: "DRAFT" }), false],
    ["a CASH row carrying a foreign payment group", row({ paymentGroupId: "grp-1" }), false],
  ])("%s -> %s", (_name, p, expected) => {
    expect(isTillCashRow("ord-1", p as never)).toBe(expected);
  });
});
