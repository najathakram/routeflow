import { isTillCashRow } from "./counter-till-cash";
import { legGroupId } from "./counter-tender-row";
import { pickupTenderGroupId } from "./pickup-tender-group";

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
    expect(isTillCashRow("ord-1", p as never, { counterSale: true }, [p as never])).toBe(expected);
  });

  it.each([
    [
      "its own pickup-group CASH row (the hand-over cash)",
      row({ paymentGroupId: pickupTenderGroupId("ord-1") }),
      true,
    ],
    [
      "its own pickup-group CREDIT_CARD row (a tender, not cash)",
      row({ method: "CREDIT_CARD", paymentGroupId: pickupTenderGroupId("ord-1") }),
      false,
    ],
    [
      "another order's pickup-group CASH row",
      row({ paymentGroupId: pickupTenderGroupId("ord-2") }),
      false,
    ],
  ])("on a counter order: %s -> %s", (_name, p, expected) => {
    expect(isTillCashRow("ord-1", p as never, { counterSale: true }, [p as never])).toBe(expected);
  });

  it.each([
    ["its own pickup-group CASH row", row({ paymentGroupId: pickupTenderGroupId("ord-1") }), true],
    [
      "its own pickup-group CREDIT_CARD row (a tender, not cash)",
      row({ method: "CREDIT_CARD", paymentGroupId: pickupTenderGroupId("ord-1") }),
      false,
    ],
    ["an ungrouped CASH row (an office or driver payment)", row(), false],
    ["a random-group CASH row (a route payment)", row({ paymentGroupId: "grp-1" }), false],
  ])("on a non-counter order: %s -> %s", (_name, p, expected) => {
    expect(isTillCashRow("ord-1", p as never, { counterSale: false }, [p as never])).toBe(expected);
  });

  // SA-749r2 meets SA-750r3: the ONE predicate is judged against the sale's rows as a set.
  describe("a split sale's rows (the sale as a set)", () => {
    const leg = (i: number, over: Record<string, unknown> = {}) =>
      row({ paymentGroupId: legGroupId("ord-1", i), ...over });

    it("a counter sale's cash LEG is till cash, whichever leg index it is", () => {
      const card = leg(0, { method: "CREDIT_CARD" });
      const cash = leg(1);
      const set = [card, cash] as never[];
      expect(isTillCashRow("ord-1", cash as never, { counterSale: true }, set)).toBe(true);
      expect(isTillCashRow("ord-1", card as never, { counterSale: true }, set)).toBe(false);
    });

    it("an ungrouped CASH row beside a leg row is an office payment: not till cash", () => {
      const cash = leg(1);
      const office = row();
      const set = [cash, office] as never[];
      expect(isTillCashRow("ord-1", office as never, { counterSale: true }, set)).toBe(false);
      // the same ungrouped row on a legacy sale (no leg row at all) stays till cash
      expect(
        isTillCashRow("ord-1", office as never, { counterSale: true }, [office] as never[]),
      ).toBe(true);
    });

    it("another order's leg row is foreign money here", () => {
      const stray = row({ paymentGroupId: legGroupId("ord-2", 0) });
      expect(
        isTillCashRow("ord-1", stray as never, { counterSale: true }, [stray] as never[]),
      ).toBe(false);
    });
  });
});
