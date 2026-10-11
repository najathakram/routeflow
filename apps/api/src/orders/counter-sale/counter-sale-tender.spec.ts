import { planSaleTender, readStoredTender, type InvoiceRow } from "./counter-sale-tender";
import { legGroupId } from "./counter-tender-row";

/** The pure half of the split tender: leg placement over the sale's invoices and row-to-leg attribution. */
const inv = (id: string, total: number, payments: InvoiceRow["payments"] = []): InvoiceRow => ({
  id,
  total,
  payments,
});
const pay = (id: string, amount: number, method: string, group: string | null = null) => ({
  id,
  amount,
  method,
  status: "PAID",
  paymentGroupId: group,
});

describe("planSaleTender: one leg keeps the rule from before split payments", () => {
  it("an omitted amount is the exact balance; cash over the balance places the balance and gives change", () => {
    expect(planSaleTender([inv("a", 37.25)], [{ method: "CARD" }])).toEqual({
      placements: [{ legIndex: 0, invoiceId: "a", amountCents: 3725 }],
    });
    expect(planSaleTender([inv("a", 37.25)], [{ method: "CASH", amount: 50 }])).toEqual({
      placements: [{ legIndex: 0, invoiceId: "a", amountCents: 3725 }],
      cashTenderedCents: 5000,
    });
  });

  it("a tender below the balance is a PARTIAL payment of exactly what was tendered", () => {
    expect(planSaleTender([inv("a", 37.25)], [{ method: "CASH", amount: 20 }]).placements).toEqual([
      { legIndex: 0, invoiceId: "a", amountCents: 2000 },
    ]);
  });

  it("a card or check above the balance is COUNTER_PAYMENT_EXCEEDS_TOTAL; a zero tender is COUNTER_TENDER_SHORT", () => {
    expect(planSaleTender([inv("a", 37.25)], [{ method: "CARD", amount: 99 }])).toEqual({
      placements: [],
      refusal: "COUNTER_PAYMENT_EXCEEDS_TOTAL",
    });
    expect(planSaleTender([inv("a", 37.25)], [{ method: "CASH", amount: 0 }]).refusal).toBe(
      "COUNTER_TENDER_SHORT",
    );
  });

  it("nothing owing (credit covered it) or ON_ACCOUNT takes nothing and refuses nothing", () => {
    const covered = inv("a", 40, [pay("cn", 40, "CREDIT_NOTE")]);
    expect(planSaleTender([covered], [{ method: "CARD", amount: 20 }])).toEqual({
      placements: [],
    });
    expect(planSaleTender([inv("a", 40)], [{ method: "ON_ACCOUNT" }])).toEqual({
      placements: [],
    });
  });

  it("an invoice whose credit exceeds its total owes nothing (clamped at 0), not a MoneyInvariantError after the sale committed", () => {
    const overCredited = inv("a", 40, [pay("cn", 50, "CREDIT_NOTE")]);
    expect(planSaleTender([overCredited], [{ method: "CASH", amount: 20 }])).toEqual({
      placements: [],
      cashTenderedCents: 2000,
    });
    // a split over an over-credited sibling plans against the other invoice only
    const out = planSaleTender(
      [overCredited, inv("b", 30)],
      [
        { method: "CARD", amount: 10 },
        { method: "CASH", amount: 30 },
      ],
    );
    expect(out.placements).toEqual([
      { legIndex: 0, invoiceId: "b", amountCents: 1000 },
      { legIndex: 1, invoiceId: "b", amountCents: 2000 },
    ]);
  });

  it("the plan is against the PRE-tender balance: stored tender rows do not shrink it, wallet credit does", () => {
    const stored = inv("a", 40, [pay("cn", 10, "CREDIT_NOTE"), pay("p1", 30, "CASH", "g")]);
    expect(planSaleTender([stored], [{ method: "CASH", amount: 30 }]).placements).toEqual([
      { legIndex: 0, invoiceId: "a", amountCents: 3000 },
    ]);
  });
});

describe("planSaleTender: a split", () => {
  it("inv1 50 / inv2 20: card 30 + cash 50 -> card {inv1 30}, cash {inv1 20, inv2 20}, change 10", () => {
    const out = planSaleTender(
      [inv("inv1", 50), inv("inv2", 20)],
      [
        { method: "CARD", amount: 30 },
        { method: "CASH", amount: 50 },
      ],
    );
    expect(out.placements).toEqual([
      { legIndex: 0, invoiceId: "inv1", amountCents: 3000 },
      { legIndex: 1, invoiceId: "inv1", amountCents: 2000 },
      { legIndex: 1, invoiceId: "inv2", amountCents: 2000 },
    ]);
  });

  it("is all or nothing: one over-covering non-cash leg refuses every leg", () => {
    const out = planSaleTender(
      [inv("a", 20)],
      [
        { method: "CARD", amount: 30 },
        { method: "CASH", amount: 40 },
      ],
    );
    expect(out).toEqual({
      placements: [],
      cashTenderedCents: 4000,
      refusal: "COUNTER_PAYMENT_EXCEEDS_TOTAL",
    });
  });
});

describe("readStoredTender: which row is which leg", () => {
  const g0 = legGroupId("ord-1", 0);
  const g1 = legGroupId("ord-1", 1);

  it("rows with the sale's group ids are grouped by leg index", () => {
    const a = inv("a", 70, [pay("p0", 30, "CREDIT_CARD", g0), pay("p1", 40, "CASH", g1)]);
    const s = readStoredTender("ord-1", [a]);
    expect(s.legacy).toBe(false);
    expect([...s.byLeg.keys()].sort()).toEqual([0, 1]);
    expect(s.byLeg.get(1)![0]).toMatchObject({ invoiceId: "a", amountCents: 4000 });
  });

  it("with NO grouped row every tender row is leg 0's (a pre-split attempt), and credit rows are not tender", () => {
    const a = inv("a", 70, [pay("old", 30, "CASH"), pay("cn", 5, "CREDIT_NOTE")]);
    const s = readStoredTender("ord-1", [a]);
    expect(s.legacy).toBe(true);
    expect(s.byLeg.get(0)!.map((r) => r.payment.id)).toEqual(["old"]);
  });

  it("once a grouped row exists, a later office payment (no/other group id) is not the sale's tender", () => {
    const a = inv("a", 100, [
      pay("p0", 30, "CREDIT_CARD", g0),
      pay("office", 20, "CASH", null),
      pay("office2", 10, "CASH", "00000000-0000-4000-8000-000000000000"),
    ]);
    const s = readStoredTender("ord-1", [a]);
    expect(s.legacy).toBe(false);
    expect([...s.byLeg.keys()]).toEqual([0]);
    expect(s.byLeg.get(0)).toHaveLength(1);
  });

  it("another order's group ids are not this sale's", () => {
    const a = inv("a", 70, [pay("p0", 30, "CREDIT_CARD", legGroupId("ord-OTHER", 0))]);
    const s = readStoredTender("ord-1", [a]);
    expect(s.legacy).toBe(true);
  });

  it("a VOID tender row is not stored tender", () => {
    const a = inv("a", 70, [{ ...pay("p0", 30, "CASH", g0), status: "VOID" }]);
    expect(readStoredTender("ord-1", [a]).byLeg.size).toBe(0);
  });
});

describe("planSaleTender: cashTenderedCents is the cash LEG's handed-over amount (SA-749r2)", () => {
  it("card 30 + cash 50 on 70: cash handed 50 at leg 1, whichever index it is", () => {
    const plan = planSaleTender(
      [inv("a", 70)],
      [
        { method: "CARD", amount: 30 },
        { method: "CASH", amount: 50 },
      ],
    );
    expect(plan.cashTenderedCents).toBe(5000);
  });

  it("cash first, card second: still the cash leg's amount (leg 0)", () => {
    const plan = planSaleTender(
      [inv("a", 70)],
      [
        { method: "CASH", amount: 50 },
        { method: "CARD", amount: 30 },
      ],
    );
    expect(plan.cashTenderedCents).toBe(5000);
    expect(plan.placements.map((p) => [p.legIndex, p.amountCents])).toEqual([
      [1, 3000],
      [0, 4000],
    ]);
  });

  it("a lone cash leg with no amount tenders the exact balance", () => {
    expect(planSaleTender([inv("a", 37.25)], [{ method: "CASH" }]).cashTenderedCents).toBe(3725);
  });

  it("no cash leg: undefined (nothing is stored)", () => {
    expect(
      planSaleTender([inv("a", 37.25)], [{ method: "CARD", amount: 37.25 }]).cashTenderedCents,
    ).toBeUndefined();
  });
});
