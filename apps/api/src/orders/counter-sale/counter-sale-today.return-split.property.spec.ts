import { roundMoney, sumConfirmed } from "@routeflow/pricing";
import {
  TODAYS_SALE_METHOD_ORDER,
  counterReturnSplit,
  type CounterReturnSplitInput,
  type ReturnProvenance,
  type TodayOrderRecord,
} from "./counter-sale-today";

/**
 * #3576 review nit (SA-838a): a seeded property spec for `counterReturnSplit`, the ONE derivation of a counter sale's
 * tender split and return lines. The generator reaches the shapes a hand-written case misses: VOID credit notes, INLINE
 * returns carried on other orders, a payment whose note was issued against ANOTHER order's invoice (disagreeing links),
 * non-PAID payments, and one credit note shared by two returns. Every property is either a definition from the module
 * docs or a metamorphic "this input cannot matter" check. Placeholders only (acme).
 */
type Pay = CounterReturnSplitInput["payments"][number];
type Ret = TodayOrderRecord["returns"][number];

const ORDER = "o-a";
const INVOICES = ["i-1", "i-2"];
const NOTES = ["cn-1", "cn-2", "cn-3"];

// The HIGH bits of an LCG (its low bits repeat on a short cycle and would tie one draw to the next; #3587 review).
let seed = 3576;
const next = (n: number) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return (seed >>> 16) % n;
};
const pick = <T>(xs: readonly T[]): T => xs[next(xs.length)];
const money = () => roundMoney((1 + next(5000)) / 100);

function sample(): CounterReturnSplitInput {
  // a note's issuing invoice is a property of the NOTE: every payment of one note carries the same one. "i-other" is
  // another order's invoice (a disagreeing link); null is a note with no invoice.
  const issuedOn = new Map<string, string | null>(
    NOTES.map((id) => [id, pick(["i-1", "i-2", "i-other", null] as const)]),
  );
  const payments: Pay[] = [];
  for (let i = 0, n = 1 + next(4); i < n; i++) {
    const status = pick(["PAID", "PAID", "PAID", "PENDING", "FAILED", "VOID"]);
    if (next(2) === 0) {
      payments.push({ method: pick(["CASH", "CARD", "CHECK"]), amount: money(), status });
    } else {
      payments.push({
        method: "CREDIT_NOTE",
        amount: money(),
        status,
        ...((id) => ({ creditNoteId: id, creditNote: { invoiceId: issuedOn.get(id) ?? null } }))(
          pick(NOTES),
        ),
      });
    }
  }
  const returns: Ret[] = [];
  for (let i = 0, n = next(3); i < n; i++) {
    returns.push({
      id: `r-${i}`,
      returnNumber: `RET-${i}`,
      status: pick(["REFUNDED", "PENDING", "REJECTED", "CANCELLED"]),
      refundMethod: pick(["CREDIT_NOTE", "CREDIT_NOTE", "EXTERNAL_REFUND"]),
      // two own returns may name ONE note (a shared note)
      creditNoteId: next(5) === 0 ? null : pick(NOTES),
      refundAmount: null,
      creditSubtotal: String(money()),
      creditTax: "0.00",
      creditCategoryTax: "0.00",
    } as Ret);
  }
  const carriedReturns: ReturnProvenance[] = [];
  for (let i = 0, n = next(3); i < n; i++) {
    carriedReturns.push({
      id: `rc-${i}`,
      creditNoteId: pick(NOTES),
      orderId: pick(["o-b", "o-c"]),
      kind: "INLINE",
      status: pick(["REFUNDED", "PENDING"]),
      refundMethod: "CREDIT_NOTE",
      refundedAt: null,
      // an item sold on THIS order (an own INLINE return) or only elsewhere (foreign)
      items: [
        {
          sourceOrderId: pick([ORDER, "o-z"]),
          subtotal: String(money()),
          taxAmount: "0.00",
          categoryTax: null,
        },
      ],
    } as ReturnProvenance);
  }
  const creditNotes = new Map(
    NOTES.map((id) => {
      const appliedAnywhere = money();
      return [
        id,
        {
          status: pick(["ISSUED", "APPLIED", "VOID"]),
          appliedAnywhere,
          ...(next(2) === 0
            ? {
                applications: [
                  { amount: appliedAnywhere, invoiceId: pick(["i-1", "i-other", null]) },
                ],
              }
            : {}),
        },
      ];
    }),
  );
  // A uniform draw almost never lines up a live own return, its live note and a PAID application of that note on this
  // order's invoice, so a third of the sales also carry one COHERENT own-credit settlement (on top of the noise above).
  if (next(3) === 0) {
    issuedOn.set("cn-1", "i-1");
    for (const p of payments) if (p.creditNoteId === "cn-1") p.creditNote = { invoiceId: "i-1" };
    const worth = money();
    returns.push({
      id: "r-own",
      returnNumber: "RET-OWN",
      status: "REFUNDED",
      refundMethod: "CREDIT_NOTE",
      creditNoteId: "cn-1",
      refundAmount: null,
      creditSubtotal: String(worth),
      creditTax: "0.00",
      creditCategoryTax: "0.00",
    } as Ret);
    const spent = roundMoney(worth * ((1 + next(10)) / 10));
    payments.push({
      method: "CREDIT_NOTE",
      amount: spent,
      status: "PAID",
      creditNoteId: "cn-1",
      creditNote: { invoiceId: "i-1" },
    });
    creditNotes.set("cn-1", {
      status: "APPLIED",
      appliedAnywhere: spent,
      applications: [{ amount: spent, invoiceId: "i-1" }],
    });
  }
  return { orderId: ORDER, invoiceIds: INVOICES, payments, returns, carriedReturns, creditNotes };
}

const cents = (n: number) => Math.round(n * 100);
const paidSum = (ps: readonly Pay[]) =>
  roundMoney(sumConfirmed(ps.map((p) => ({ amount: p.amount, status: p.status }))));

describe("counterReturnSplit: seeded properties (#3576 review nit)", () => {
  const N = 800;
  const cases = Array.from({ length: N }, () => sample());

  it("the tender methods add up to tenderPaid, each > 0, in the till's order", () => {
    for (const input of cases) {
      const r = counterReturnSplit(input);
      expect(cents(r.tenderMethods.reduce((s, m) => s + m.amount, 0))).toBe(cents(r.tenderPaid));
      expect(r.tenderMethods.every((m) => m.amount > 0)).toBe(true);
      const order = r.tenderMethods.map((m) => TODAYS_SALE_METHOD_ORDER.indexOf(m.method));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });

  it("no money is hidden: tenders + own return credit never exceed what was PAID; return lines are never negative", () => {
    for (const input of cases) {
      const r = counterReturnSplit(input);
      expect(cents(r.tenderPaid) + cents(r.returnCredit)).toBeLessThanOrEqual(
        cents(paidSum(input.payments)),
      );
      const { applied, refunded, kept, used } = r.returnLines;
      expect([applied, refunded, kept, used].every((v) => v >= 0)).toBe(true);
    }
  });

  it("a PAID payment with no credit note, or whose note was issued against ANOTHER order's invoice, is always a tender", () => {
    for (const input of cases) {
      const r = counterReturnSplit(input);
      const alwaysTender = input.payments.filter(
        (p) =>
          p.status === "PAID" &&
          (!p.creditNoteId ||
            !p.creditNote?.invoiceId ||
            !input.invoiceIds.includes(p.creditNote.invoiceId)),
      );
      expect(cents(r.tenderPaid)).toBeGreaterThanOrEqual(cents(paidSum(alwaysTender)));
    }
  });

  it("non-PAID payments never change anything", () => {
    for (const input of cases) {
      const onlyPaid = { ...input, payments: input.payments.filter((p) => p.status === "PAID") };
      expect(counterReturnSplit(input)).toEqual(counterReturnSplit(onlyPaid));
    }
  });

  it("a carried INLINE return with nothing sold on this order never changes anything", () => {
    for (const input of cases) {
      const own = (input.carriedReturns ?? []).filter((c) =>
        (c.items ?? []).some((i) => i.sourceOrderId === ORDER),
      );
      expect(counterReturnSplit(input)).toEqual(
        counterReturnSplit({ ...input, carriedReturns: own }),
      );
    }
  });

  it("an own return whose credit note is VOID (no recorded refund) is dead: dropping it changes nothing", () => {
    for (const input of cases) {
      const voidNote = (id: string | null) => !!id && input.creditNotes?.get(id)?.status === "VOID";
      const alive = input.returns.filter(
        (r) => !(voidNote(r.creditNoteId) && r.refundMethod === "CREDIT_NOTE"),
      );
      expect(counterReturnSplit(input)).toEqual(counterReturnSplit({ ...input, returns: alive }));
    }
  });

  it("is not vacuous: the grid holds sales with own return credit, tenders, shared notes and disagreeing links", () => {
    const results = cases.map((c) => counterReturnSplit(c));
    expect(results.filter((r) => r.returnCredit > 0).length).toBeGreaterThan(10);
    expect(results.filter((r) => r.tenderMethods.length > 0).length).toBeGreaterThan(100);
    expect(
      cases.filter((c) => {
        const ids = c.returns.map((r) => r.creditNoteId).filter(Boolean);
        return new Set(ids).size < ids.length;
      }).length,
    ).toBeGreaterThan(10);
    expect(
      cases.filter((c) => c.payments.some((p) => p.creditNote?.invoiceId === "i-other")).length,
    ).toBeGreaterThan(50);
  });
});
