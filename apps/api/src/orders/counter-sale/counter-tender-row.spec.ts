import {
  counterTenderCashRows,
  isCounterTenderGroup,
  isCounterTenderRow,
  isForeignPaymentRow,
  legGroupId,
  tenderSetOf,
  tenderTakenCents,
  type TenderRowShape,
} from "./counter-tender-row";
import { isTillCashRow } from "./counter-till-cash";
import { pickupTenderGroupId } from "./pickup-tender-group";

// SA-762r F3: one tender-row predicate for the counter void and (SA-750r2 item 6) the counter-close lock; SA-750r3 gives it
// the order's kind (counter sale vs a POS pickup hand-over), SA-749r2 the sale as a SET (the split tender's leg ids).
const ORDER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
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
    // a lone row is its own sale set: the legacy (ungrouped) rule applies to it
    expect(isCounterTenderRow(ORDER, p, COUNTER, [p])).toBe(kind === "tender");
    expect(isForeignPaymentRow(ORDER, p, COUNTER, [p])).toBe(kind === "foreign");
  });

  // SA-750r3 r-note (Train 4 meets day close): ONE predicate, two clauses, keyed on the order's kind.
  describe("the order's kind (counter sale vs a POS-mode pickup hand-over)", () => {
    const PICKUP = pickupTenderGroupId(ORDER);
    const OTHER_PICKUP = pickupTenderGroupId(OTHER);
    const RANDOM = "5b0f4a6e-2b0a-4c53-9a54-6f1c8d1f2a11";
    const kinds: Array<
      [string, { counterSale?: boolean | null }, string | null | undefined, boolean]
    > = [
      // clause (i): a counter-sale order: ungrouped, or its OWN pickup hand-over id (pickup-complete runs on counter sales too)
      ["counter order, ungrouped", COUNTER, null, true],
      ["counter order, undefined group", COUNTER, undefined, true],
      ["counter order, a random group (office payment)", COUNTER, RANDOM, false],
      ["counter order, its OWN pickup group id (the hand-over cash)", COUNTER, PICKUP, true],
      ["counter order, another order's pickup group id", COUNTER, OTHER_PICKUP, false],
      ["counter order, the order id used as a group id", COUNTER, ORDER, false],
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
      expect(isCounterTenderGroup(ORDER, tenderSetOf(ORDER, []), group, order)).toBe(expected);
      const p = row({ paymentGroupId: group });
      expect(isCounterTenderRow(ORDER, p, order, [p])).toBe(expected);
    });

    it("a hand-over's method rules still apply: a pickup-group CASH / card / PENDING row is a tender, a DRAFT / ACH / deposited check is not", () => {
      const own = (over: Partial<TenderRowShape>) => row({ paymentGroupId: PICKUP, ...over });
      const is = (p: TenderRowShape) => isCounterTenderRow(ORDER, p, NON_COUNTER, [p]);
      expect(is(own({}))).toBe(true);
      expect(is(own({ method: "CREDIT_CARD" }))).toBe(true);
      expect(is(own({ status: "PENDING" }))).toBe(true);
      expect(is(own({ status: "DRAFT" }))).toBe(false);
      expect(is(own({ method: "ACH" }))).toBe(false);
      expect(is(own({ method: "CHECK", checkStatus: "DEPOSITED" }))).toBe(false);
    });

    it("a counter order's own-pickup-group rows follow the method rules (CASH / card tender, DRAFT / ACH / deposited check not)", () => {
      const own = (over: Partial<TenderRowShape>) => row({ paymentGroupId: PICKUP, ...over });
      const is = (p: TenderRowShape) => isCounterTenderRow(ORDER, p, COUNTER, [p]);
      expect(is(own({}))).toBe(true);
      expect(is(own({ method: "CREDIT_CARD" }))).toBe(true);
      expect(is(own({ status: "PENDING" }))).toBe(true);
      expect(is(own({ status: "DRAFT" }))).toBe(false);
      expect(is(own({ method: "ACH" }))).toBe(false);
      expect(is(own({ method: "CHECK", checkStatus: "DEPOSITED" }))).toBe(false);
      expect(isForeignPaymentRow(ORDER, own({}), COUNTER, [own({})])).toBe(false);
      const other = own({ paymentGroupId: OTHER_PICKUP });
      expect(isForeignPaymentRow(ORDER, other, COUNTER, [other])).toBe(true);
    });

    it("isForeignPaymentRow follows: a non-counter order's ungrouped CASH row is foreign, its pickup-group row is not", () => {
      const foreign = (p: TenderRowShape) => isForeignPaymentRow(ORDER, p, NON_COUNTER, [p]);
      expect(foreign(row({}))).toBe(true);
      expect(foreign(row({ paymentGroupId: PICKUP }))).toBe(false);
      expect(foreign(row({ status: "VOID" }))).toBe(false);
    });
  });
});

// SET-LEVEL (SA-749r2): on the split base every new sale's tender rows carry a leg group id (single-method sales
// included), so the group id can only be judged against the rest of the sale. The order's kind still applies on top.
describe("isCounterTenderRow / isForeignPaymentRow: the sale as a set", () => {
  const PICKUP = pickupTenderGroupId(ORDER);
  const leg = (i: number, over: Partial<TenderRowShape> = {}) =>
    row({ paymentGroupId: legGroupId(ORDER, i), ...over });
  const verdict = (p: TenderRowShape, set: TenderRowShape[], order = COUNTER) =>
    isCounterTenderRow(ORDER, p, order, set)
      ? "tender"
      : isForeignPaymentRow(ORDER, p, order, set)
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

  it("a VOID grouped row still makes the sale a split one (it was rung on the split base): the ungrouped row is foreign, the VOID row neither", () => {
    const voided = leg(0, { status: "VOID" });
    const later = row({});
    expect(verdict(later, [voided, later])).toBe("foreign");
    expect(verdict(voided, [voided, later])).toBe("ignored");
  });

  it("the leg group id is a stable per-order, per-leg uuid", () => {
    expect(legGroupId(ORDER, 0)).toBe(legGroupId(ORDER, 0));
    expect(legGroupId(ORDER, 0)).not.toBe(legGroupId(ORDER, 1));
    expect(legGroupId(ORDER, 0)).not.toBe(legGroupId(OTHER, 0));
  });

  // The two sides meet: day close's order-kind clauses AND the split's set-level rule, in ONE predicate.
  describe("order kind x sale set", () => {
    it("a counter sale's pickup hand-over cash is tender BESIDE its grouped legs (and its own legs still are)", () => {
      const sale = leg(0, { method: "CREDIT_CARD" });
      const handOver = row({ paymentGroupId: PICKUP });
      expect(verdict(handOver, [sale, handOver])).toBe("tender");
      expect(verdict(sale, [sale, handOver])).toBe("tender");
    });

    it("a hand-over row is no 'grouped' leg: a legacy sale's ungrouped till tender stays tender beside it", () => {
      const legacy = row({});
      const handOver = row({ paymentGroupId: PICKUP });
      expect(verdict(legacy, [legacy, handOver])).toBe("tender");
    });

    it("a counter sale's ungrouped office payment is foreign once a leg row exists, whatever the hand-over", () => {
      const sale = leg(0);
      const handOver = row({ paymentGroupId: PICKUP });
      const office = row({});
      expect(verdict(office, [sale, handOver, office])).toBe("foreign");
    });

    it("a NON-counter order never reads a leg id or an ungrouped row as tender", () => {
      const stray = leg(0);
      const ungrouped = row({});
      expect(verdict(stray, [stray], NON_COUNTER)).toBe("foreign");
      expect(verdict(ungrouped, [ungrouped], NON_COUNTER)).toBe("foreign");
      const own = row({ paymentGroupId: PICKUP });
      expect(verdict(own, [own, stray], NON_COUNTER)).toBe("tender");
    });

    it("isTillCashRow IS the predicate plus CASH: a leg's cash, a hand-over's cash; never a card leg or an office row", () => {
      const card = leg(0, { method: "CREDIT_CARD" });
      const cash = leg(1);
      const office = row({});
      const handOver = row({ paymentGroupId: PICKUP });
      const set = [card, cash, office, handOver];
      expect(isTillCashRow(ORDER, cash, COUNTER, set)).toBe(true);
      expect(isTillCashRow(ORDER, handOver, COUNTER, set)).toBe(true);
      expect(isTillCashRow(ORDER, card, COUNTER, set)).toBe(false);
      expect(isTillCashRow(ORDER, office, COUNTER, set)).toBe(false);
      // and on a POS-mode pickup order only the hand-over id is till cash
      expect(isTillCashRow(ORDER, handOver, NON_COUNTER, [handOver])).toBe(true);
      expect(isTillCashRow(ORDER, cash, NON_COUNTER, [cash])).toBe(false);
    });
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

  it("a later pickup hand-over's cash is till cash (the predicate) but not the tender's cash leg", () => {
    const leg = cash({ paymentGroupId: legGroupId(ORDER, 0) });
    const handOver = cash({ paymentGroupId: pickupTenderGroupId(ORDER) });
    expect(isTillCashRow(ORDER, handOver, COUNTER, [leg, handOver])).toBe(true);
    expect(counterTenderCashRows(ORDER, [leg, handOver])).toEqual([leg]);
  });
});

describe("tenderTakenCents: what the sale's own tender took", () => {
  const pay = (amount: number, over: Record<string, unknown> = {}) => ({
    amount,
    method: "CASH",
    status: "PAID",
    paymentGroupId: legGroupId(ORDER, 0) as string | null,
    ...over,
  });

  it("counts the legs, a voided leg too, and the credit applied up front", () => {
    expect(
      tenderTakenCents(ORDER, [
        pay(30),
        pay(10, { method: "CREDIT_CARD", paymentGroupId: legGroupId(ORDER, 1), status: "VOID" }),
        pay(5, { method: "CREDIT_NOTE", paymentGroupId: null }),
      ]),
    ).toBe(4500);
  });

  it("a later hand-over's cash does not complete an interrupted tender", () => {
    expect(
      tenderTakenCents(ORDER, [pay(20), pay(30, { paymentGroupId: pickupTenderGroupId(ORDER) })]),
    ).toBe(2000);
  });
});

// A2: the set keeps VOID rows for the "has a leg-grouped row" decision (a VOID row never counts as tender itself).
describe("tenderSetOf: voided leg rows and the rest of the order still make the sale grouped", () => {
  const voidedLeg = row({ paymentGroupId: legGroupId(ORDER, 0), status: "VOID" });
  const office = row({});

  it("a sale whose leg rows were ALL voided reads as grouped: a later ungrouped cash row is foreign, not legacy tender", () => {
    expect(tenderSetOf(ORDER, [voidedLeg]).hasGrouped).toBe(true);
    expect(isCounterTenderRow(ORDER, office, COUNTER, [voidedLeg, office])).toBe(false);
    expect(isForeignPaymentRow(ORDER, office, COUNTER, [voidedLeg, office])).toBe(true);
    // the voided row itself is neither
    expect(isCounterTenderRow(ORDER, voidedLeg, COUNTER, [voidedLeg, office])).toBe(false);
    expect(isForeignPaymentRow(ORDER, voidedLeg, COUNTER, [voidedLeg, office])).toBe(false);
  });

  it("counterTenderCashRows / tenderTakenCents judge the legacy rule with the same set (and the evidence rows)", () => {
    const evidence = [{ paymentGroupId: legGroupId(ORDER, 1) }]; // a leg row on a voided sibling invoice
    expect(counterTenderCashRows(ORDER, [office])).toEqual([office]);
    expect(counterTenderCashRows(ORDER, [office], evidence)).toEqual([]);
    const paid = { amount: 20, method: "CASH", status: "PAID", paymentGroupId: null };
    expect(tenderTakenCents(ORDER, [paid])).toBe(2000);
    expect(tenderTakenCents(ORDER, [paid], evidence)).toBe(0);
  });
});
