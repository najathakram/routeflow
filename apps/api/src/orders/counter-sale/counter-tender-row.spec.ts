import {
  isCounterTenderRow,
  counterTenderCashRows,
  isForeignPaymentRow,
  legGroupId,
  type TenderRowShape,
} from "./counter-tender-row";

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
    // a lone row is its own sale set: the legacy (ungrouped) rule applies to it
    expect(isCounterTenderRow(ORDER, p, [p])).toBe(kind === "tender");
    expect(isForeignPaymentRow(ORDER, p, [p])).toBe(kind === "foreign");
  });
});

// SET-LEVEL (SA-749r2): on the split base every new sale's tender rows carry a leg group id (single-method sales
// included), so the group id can only be judged against the rest of the sale.
describe("isCounterTenderRow / isForeignPaymentRow: the sale as a set", () => {
  const OTHER = "22222222-2222-4222-8222-222222222222";
  const leg = (i: number, over: Partial<TenderRowShape> = {}) =>
    row({ paymentGroupId: legGroupId(ORDER, i), ...over });
  const verdict = (p: TenderRowShape, set: TenderRowShape[]) =>
    isCounterTenderRow(ORDER, p, set)
      ? "tender"
      : isForeignPaymentRow(ORDER, p, set)
        ? "foreign"
        : "ignored";

  it("a single-method NEW sale: its one grouped row is the counter's tender, not foreign", () => {
    const only = leg(0);
    expect(verdict(only, [only])).toBe("tender");
  });

  it("a card + cash split: both legs are the counter's tender", () => {
    const card = leg(0, { method: "CREDIT_CARD" });
    const cash = leg(1);
    expect(verdict(card, [card, cash])).toBe("tender");
    expect(verdict(cash, [card, cash])).toBe("tender");
  });

  it("a split across two invoices: a leg's several rows are all tender", () => {
    const a = leg(1);
    const b = leg(1);
    expect(verdict(a, [a, b])).toBe("tender");
  });

  it("an UNGROUPED office payment on a sale that has grouped tender IS foreign", () => {
    const sale = leg(0);
    const office = row({ method: "CHECK", checkStatus: "RECORDED" });
    expect(verdict(office, [sale, office])).toBe("foreign");
    expect(verdict(sale, [sale, office])).toBe("tender");
  });

  it("an office multi-invoice payment (random group id) beside the tender is foreign", () => {
    const sale = leg(0);
    const office = row({ paymentGroupId: "5b0f4a6e-2b0a-4c53-9a54-6f1c8d1f2a11" });
    expect(verdict(office, [sale, office])).toBe("foreign");
  });

  it("a leg id of ANOTHER order is foreign, and does not make this sale 'grouped'", () => {
    const legacy = row({});
    const stray = row({ paymentGroupId: legGroupId(OTHER, 0) });
    expect(verdict(stray, [legacy, stray])).toBe("foreign");
    expect(verdict(legacy, [legacy, stray])).toBe("tender");
  });

  it("a leg index at the limit (4) is not this sale's leg", () => {
    const beyond = row({ paymentGroupId: legGroupId(ORDER, 4) });
    expect(verdict(beyond, [beyond])).toBe("foreign");
  });

  it("a LEGACY sale (no grouped row at all): its ungrouped rows are the tender", () => {
    const cash = row({});
    const card = row({ method: "CREDIT_CARD" });
    expect(verdict(cash, [cash, card])).toBe("tender");
    expect(verdict(card, [cash, card])).toBe("tender");
  });

  it("a VOID grouped row does not turn a legacy sale into a split one", () => {
    const voided = leg(0, { status: "VOID" });
    const legacy = row({});
    expect(verdict(legacy, [voided, legacy])).toBe("tender");
    expect(verdict(voided, [voided, legacy])).toBe("ignored");
  });

  it("the leg group id is a stable per-order, per-leg uuid", () => {
    expect(legGroupId(ORDER, 0)).toBe(legGroupId(ORDER, 0));
    expect(legGroupId(ORDER, 0)).not.toBe(legGroupId(ORDER, 1));
    expect(legGroupId(ORDER, 0)).not.toBe(legGroupId(OTHER, 0));
  });
});

describe("counterTenderCashRows: the cash rows the change is measured against", () => {
  const cash = (over: Partial<TenderRowShape> = {}) => row({ method: "CASH", ...over });

  it("a card-first split's cash leg is found; the card leg is not", () => {
    const card = row({ method: "CREDIT_CARD", paymentGroupId: legGroupId(ORDER, 0) });
    const leg = cash({ paymentGroupId: legGroupId(ORDER, 1) });
    expect(counterTenderCashRows(ORDER, [card, leg])).toEqual([leg]);
  });

  it("an ungrouped office CASH row beside grouped tender is not the cash leg's", () => {
    const leg = cash({ paymentGroupId: legGroupId(ORDER, 0) });
    const office = cash();
    expect(counterTenderCashRows(ORDER, [leg, office])).toEqual([leg]);
  });

  it("a legacy sale (no grouped row): its ungrouped cash rows are the tender; a voided one never", () => {
    const a = cash();
    const voided = cash({ status: "VOID" });
    expect(counterTenderCashRows(ORDER, [a, voided])).toEqual([a]);
  });
});
