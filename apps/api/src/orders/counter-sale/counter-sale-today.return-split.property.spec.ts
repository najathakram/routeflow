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
      // an external refund is either chosen-but-not-recorded (null) or complete (a date): the "refunded" path
      refundedAt: pick([null, new Date(0)]),
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
  // a note the batched read did NOT return is absent from the map: the not-returned path (PENDING, nothing kept)
  const creditNotes = new Map(
    NOTES.filter(() => next(4) !== 0).map((id) => {
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

const EXTERNAL_REFUND = "EXTERNAL_REFUND";
const refundDone = (r: { refundMethod?: string | null; refundedAt?: Date | null }) =>
  r.refundMethod === EXTERNAL_REFUND && r.refundedAt != null;

/**
 * The module docs as an oracle, written from the INPUT alone (it never calls pricing's settlement): the sale's LIVE own
 * returns are its STANDARD returns not rejected/cancelled, plus the carried INLINE returns with an item sold here (worth =
 * those items). One note counts once. Per return:
 *   - a completed external refund: SETTLED, refunded = worth, nothing applied anywhere;
 *   - else a VOID note: dead (prints nothing);
 *   - else a note the read returned: SETTLED, kept = max(0, worth - appliedAnywhere - refunded), where appliedAnywhere is
 *     never less than what sits on this order's invoices (PAID payments of the note, or the read's applications there);
 *   - else (no note, or a note the read did not return): PENDING, kept 0.
 */
function oracle(input: CounterReturnSplitInput) {
  type Live = { noteId: string | null; worth: number; done: boolean };
  const live: Live[] = [];
  for (const r of input.returns) {
    if (r.status === "REJECTED" || r.status === "CANCELLED") continue;
    live.push({
      noteId: r.creditNoteId,
      worth: roundMoney(Number(r.creditSubtotal)),
      done: refundDone(r),
    });
  }
  for (const c of input.carriedReturns ?? []) {
    if (c.status === "REJECTED" || c.status === "CANCELLED") continue;
    const here = (c.items ?? []).filter((i) => i.sourceOrderId === ORDER);
    if (here.length === 0) continue;
    live.push({
      noteId: c.creditNoteId,
      worth: roundMoney(here.reduce((s, i) => s + Number(i.subtotal), 0)),
      done: refundDone(c),
    });
  }
  const onInvoices = (invoiceId: string | null | undefined): boolean =>
    !!invoiceId && input.invoiceIds.includes(invoiceId);
  const seen = new Set<string>();
  let kept = 0;
  let pending = false;
  let absent = 0; // live own returns on a note the read did not return
  let settledKept = 0; // settled returns that keep a positive credit
  let doneCount = 0; // completed external refunds
  let voidDead = 0; // live own returns on a VOID note with no completed refund
  for (const l of live) {
    const fact = l.noteId ? input.creditNotes?.get(l.noteId) : undefined;
    if (!l.done && l.noteId && fact?.status === "VOID") {
      voidDead++;
      continue;
    }
    const settled = l.done || (!!l.noteId && !!fact);
    if (!settled) {
      pending = true;
      if (l.noteId) absent++;
      continue;
    }
    if (l.done) doneCount++;
    if (l.noteId) {
      if (seen.has(l.noteId)) continue;
      seen.add(l.noteId);
    }
    const refunded = l.done ? l.worth : 0;
    const proven = roundMoney(
      input.payments
        .filter(
          (p) =>
            p.status === "PAID" &&
            !!l.noteId &&
            p.creditNoteId === l.noteId &&
            onInvoices(p.creditNote?.invoiceId),
        )
        .reduce((s, p) => s + Number(p.amount), 0),
    );
    const onThisOrder = Math.max(
      proven,
      roundMoney(
        (fact?.applications ?? [])
          .filter((a) => onInvoices(a.invoiceId))
          .reduce((s, a) => s + Number(a.amount), 0),
      ),
    );
    const appliedAnywhere = l.done ? 0 : Math.max(onThisOrder, fact?.appliedAnywhere ?? 0);
    const k = Math.max(0, roundMoney(l.worth - appliedAnywhere - refunded));
    if (k > 0) settledKept++;
    kept = roundMoney(kept + k);
  }
  return { kept, pending, absent, settledKept, doneCount, voidDead };
}

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

  it("no money is hidden or invented: tenders + own return credit are EXACTLY what was PAID; return lines are never negative", () => {
    for (const input of cases) {
      const r = counterReturnSplit(input);
      expect(cents(r.tenderPaid) + cents(r.returnCredit)).toBe(cents(paidSum(input.payments)));
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

  it("an own return whose credit note is VOID (no completed refund) is dead: dropping it changes nothing", () => {
    for (const input of cases) {
      const voidNote = (id: string | null) => !!id && input.creditNotes?.get(id)?.status === "VOID";
      // dead = a VOID note with no COMPLETED refund (a recorded external refund keeps the return alive)
      const alive = input.returns.filter((r) => !(voidNote(r.creditNoteId) && !refundDone(r)));
      expect(counterReturnSplit(input)).toEqual(counterReturnSplit({ ...input, returns: alive }));
    }
  });

  it("a settled return keeps max(0, worth - credit applied ANYWHERE - refunded); one note counts once", () => {
    for (const input of cases) {
      expect(cents(counterReturnSplit(input).returnLines.kept)).toBe(cents(oracle(input).kept));
    }
  });

  it("a returned note the read did not see is PENDING and keeps nothing (never claimed as credit)", () => {
    for (const input of cases) {
      const o = oracle(input);
      const r = counterReturnSplit(input);
      // PENDING exactly when some live own return has no note, or a note the read did not return
      expect(r.returnLines.pending).toBe(o.pending);
      if (o.absent > 0) expect(r.returnLines.pending).toBe(true);
      // metamorphic: when the read returned NO note at all, only a completed external refund can settle, and it keeps 0
      const blind = counterReturnSplit({ ...input, creditNotes: new Map() });
      expect(blind.returnLines.kept).toBe(0);
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

  it("guard counts: the generator reaches every branch the properties lean on", () => {
    const os = cases.map((c) => oracle(c));
    const count = (xs: readonly boolean[]) => xs.filter(Boolean).length;
    // MUST-2: the not-returned-note path (a live own return on a note the read did not return) and a settled kept > 0
    expect(count(os.map((o) => o.absent > 0))).toBeGreaterThan(50);
    expect(count(os.map((o) => o.absent > 0 && o.pending))).toBeGreaterThan(50);
    expect(count(os.map((o) => o.settledKept > 0))).toBeGreaterThan(20);
    // a completed external refund (the refunded term of kept)
    expect(count(os.map((o) => o.doneCount > 0))).toBeGreaterThan(20);
    // an own return on a VOID note with no completed refund
    expect(count(os.map((o) => o.voidDead > 0))).toBeGreaterThan(20);
    // carried INLINE returns: one sold here (own) AND one sold only elsewhere (foreign), in the same run
    const inlineHere = (c: CounterReturnSplitInput) =>
      (c.carriedReturns ?? []).some((r) => (r.items ?? []).some((i) => i.sourceOrderId === ORDER));
    const inlineForeign = (c: CounterReturnSplitInput) =>
      (c.carriedReturns ?? []).some((r) => (r.items ?? []).every((i) => i.sourceOrderId !== ORDER));
    expect(count(cases.map(inlineHere))).toBeGreaterThan(50);
    expect(count(cases.map(inlineForeign))).toBeGreaterThan(50);
    expect(count(cases.map((c) => inlineHere(c) && inlineForeign(c)))).toBeGreaterThan(10);
    // non-PAID payments, and a non-PAID credit-note application
    expect(count(cases.map((c) => c.payments.some((p) => p.status !== "PAID")))).toBeGreaterThan(
      50,
    );
    expect(
      count(
        cases.map((c) => c.payments.some((p) => p.status !== "PAID" && p.method === "CREDIT_NOTE")),
      ),
    ).toBeGreaterThan(20);
  });
});
