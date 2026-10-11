import {
  isCounterTenderGroup,
  isCounterTenderRow,
  isForeignPaymentRow,
  type TenderRowShape,
} from "./counter-tender-row";
import { pickupTenderGroupId } from "./pickup-tender-group";

// SA-762r F3: one tender-row predicate for the counter void and (SA-750r2 item 6) the counter-close lock.
const ORDER = "11111111-1111-4111-8111-111111111111";
const COUNTER = { counterSale: true };
const NON_COUNTER = { counterSale: false };
const row = (over: Partial<TenderRowShape>): TenderRowShape => ({
  method: "CASH",
  status: "PAID",
  paymentGroupId: null,
  checkStatus: null,
  ...over,
});

describe("isCounterTenderRow / isForeignPaymentRow (table)", () => {
  const cases: Array<[string, TenderRowShape, "tender" | "foreign" | "ignored"]> = [
    ["PAID cash, no group", row({}), "tender"],
    ["PAID card, no group", row({ method: "CREDIT_CARD" }), "tender"],
    [
      "PENDING check RECORDED, no group",
      row({ method: "CHECK", status: "PENDING", checkStatus: "RECORDED" }),
      "tender",
    ],
    ["PAID check with no check status", row({ method: "CHECK" }), "tender"],
    ["undefined group counts as null", row({ paymentGroupId: undefined }), "tender"],
    [
      "office payment with a random group id",
      row({ paymentGroupId: "5b0f4a6e-2b0a-4c53-9a54-6f1c8d1f2a11" }),
      "foreign",
    ],
    [
      "the order id used as a group id is not a tender group",
      row({ paymentGroupId: ORDER }),
      "foreign",
    ],
    ["applied credit note", row({ method: "CREDIT_NOTE" }), "foreign"],
    ["advance application", row({ method: "ADVANCE" }), "foreign"],
    ["CHECK DEPOSITED", row({ method: "CHECK", checkStatus: "DEPOSITED" }), "foreign"],
    ["CHECK CLEARED", row({ method: "CHECK", checkStatus: "CLEARED" }), "foreign"],
    ["ACH", row({ method: "ACH" }), "foreign"],
    ["ZELLE", row({ method: "ZELLE" }), "foreign"],
    ["OTHER", row({ method: "OTHER" }), "foreign"],
    ["DRAFT cash is not a settled tender", row({ status: "DRAFT" }), "foreign"],
    ["VOID cash is neither", row({ status: "VOID" }), "ignored"],
    ["VOID credit note is neither", row({ method: "CREDIT_NOTE", status: "VOID" }), "ignored"],
    [
      "BOUNCED check (VOID) is neither",
      row({ method: "CHECK", status: "VOID", checkStatus: "BOUNCED" }),
      "ignored",
    ],
  ];

  it.each(cases)("%s -> %s", (_name, p, kind) => {
    expect(isCounterTenderRow(ORDER, p, COUNTER)).toBe(kind === "tender");
    expect(isForeignPaymentRow(ORDER, p, COUNTER)).toBe(kind === "foreign");
  });

  // SA-750r3 r-note (Train 4 meets day close): ONE predicate, two clauses, keyed on the order's kind.
  describe("the order's kind (counter sale vs a POS-mode pickup hand-over)", () => {
    const PICKUP = pickupTenderGroupId(ORDER);
    const OTHER_PICKUP = pickupTenderGroupId("22222222-2222-4222-8222-222222222222");
    const RANDOM = "5b0f4a6e-2b0a-4c53-9a54-6f1c8d1f2a11";
    const kinds: Array<
      [string, { counterSale?: boolean | null }, string | null | undefined, boolean]
    > = [
      // clause (i): a counter-sale order: ungrouped only (the leg ids join at SA-749r2)
      ["counter order, ungrouped", COUNTER, null, true],
      ["counter order, undefined group", COUNTER, undefined, true],
      ["counter order, a random group (office payment)", COUNTER, RANDOM, false],
      ["counter order, the pickup group id is NOT a counter tender", COUNTER, PICKUP, false],
      // clause (ii): a NON-counter order: ONLY the deterministic pickup group id of THIS order
      ["non-counter order, ungrouped (an office or driver payment)", NON_COUNTER, null, false],
      ["non-counter order, undefined group", NON_COUNTER, undefined, false],
      ["non-counter order, a random group (a driver / route payment)", NON_COUNTER, RANDOM, false],
      ["non-counter order, its own pickup group id", NON_COUNTER, PICKUP, true],
      ["non-counter order, another order's pickup group id", NON_COUNTER, OTHER_PICKUP, false],
      ["a null counterSale reads as non-counter: ungrouped", { counterSale: null }, null, false],
      ["a null counterSale reads as non-counter: pickup id", { counterSale: null }, PICKUP, true],
      ["an unset counterSale reads as non-counter", {}, null, false],
    ];
    it.each(kinds)("%s -> group accepted: %s", (_n, order, group, expected) => {
      expect(isCounterTenderGroup(ORDER, group, order)).toBe(expected);
      expect(isCounterTenderRow(ORDER, row({ paymentGroupId: group }), order)).toBe(expected);
    });

    it("a hand-over's method rules still apply: a pickup-group CASH / card / PENDING row is a tender, a DRAFT / ACH / deposited check is not", () => {
      const own = (over: Partial<TenderRowShape>) => row({ paymentGroupId: PICKUP, ...over });
      expect(isCounterTenderRow(ORDER, own({}), NON_COUNTER)).toBe(true);
      expect(isCounterTenderRow(ORDER, own({ method: "CREDIT_CARD" }), NON_COUNTER)).toBe(true);
      expect(isCounterTenderRow(ORDER, own({ status: "PENDING" }), NON_COUNTER)).toBe(true);
      expect(isCounterTenderRow(ORDER, own({ status: "DRAFT" }), NON_COUNTER)).toBe(false);
      expect(isCounterTenderRow(ORDER, own({ method: "ACH" }), NON_COUNTER)).toBe(false);
      expect(
        isCounterTenderRow(ORDER, own({ method: "CHECK", checkStatus: "DEPOSITED" }), NON_COUNTER),
      ).toBe(false);
    });

    it("isForeignPaymentRow follows: a non-counter order's ungrouped CASH row is foreign, its pickup-group row is not", () => {
      expect(isForeignPaymentRow(ORDER, row({}), NON_COUNTER)).toBe(true);
      expect(isForeignPaymentRow(ORDER, row({ paymentGroupId: PICKUP }), NON_COUNTER)).toBe(false);
      expect(isForeignPaymentRow(ORDER, row({ status: "VOID" }), NON_COUNTER)).toBe(false);
    });
  });

  // EXTENSION POINT (SA-749r2): the split tender's rows carry a derived group id. The namespace and a uuid v5
  // implementation are not on this base, so only `paymentGroupId == null` is a tender today.
  test.todo(
    "a row whose paymentGroupId is uuidv5(`<orderId>:<i>`, COUNTER_TENDER_NS) for some i < 4 is a tender",
  );
  test.todo("a row whose paymentGroupId is uuidv5 of ANOTHER order's id is foreign");
});
