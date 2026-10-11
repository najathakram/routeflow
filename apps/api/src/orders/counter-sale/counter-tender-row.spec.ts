import { isCounterTenderRow, isForeignPaymentRow, type TenderRowShape } from "./counter-tender-row";

// SA-762r F3: one tender-row predicate for the counter void and (SA-750r2 item 6) the counter-close lock.
const ORDER = "11111111-1111-4111-8111-111111111111";
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
    expect(isCounterTenderRow(ORDER, p)).toBe(kind === "tender");
    expect(isForeignPaymentRow(ORDER, p)).toBe(kind === "foreign");
  });

  // EXTENSION POINT (SA-749r2): the split tender's rows carry a derived group id. The namespace and a uuid v5
  // implementation are not on this base, so only `paymentGroupId == null` is a tender today.
  test.todo(
    "a row whose paymentGroupId is uuidv5(`<orderId>:<i>`, COUNTER_TENDER_NS) for some i < 4 is a tender",
  );
  test.todo("a row whose paymentGroupId is uuidv5 of ANOTHER order's id is foreign");
});
