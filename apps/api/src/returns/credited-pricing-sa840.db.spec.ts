/**
 * SA-840 A-2 (F1) on REAL Postgres: the refund is priced on what the lines ALREADY carry, so two refunds that together cover a
 * quantity pay what one refund of that quantity would, to the cent (the slice telescopes per invoice pool, SA-840 section 2).
 * Fixture: review-b's MULTI order (`sa840-multi-fixture.ts`): line B 100 pcs on the OLDER invoice (8% tax), line A 400 pcs on the
 * NEWER one (10% tax). A one-shot pooled 150 pcs fills B (27.00) then A (50 pcs: 11.25 + 1.13) = 39.38.
 *
 *   R-F1   a pooled 50, then a pooled 100: the two lumps sum to the one-shot pooled 150. Before: the second lump was priced on an
 *          uncredited B (27.00), 40.50 in all.
 *   R-F1b  "line B 50", then a pooled 100: the same one-shot equality.
 *   R-F1c  both pairs as EXTERNAL_REFUND: the recorded amounts sum to the one-shot.
 *   G-F1d  ONE invoice: the mint stays itemised (credit note items on the invoice's lines), and the detail estimate equals the mint
 *          when an earlier credit note exists.
 *   G-F1f  a RESOLVED return (MULTI credit note, MULTI external refund, SINGLE credit note): findOne's estimate equals refundAmount.
 *   G-F1e  REG-B53's latest-invoice room still refuses a MULTI pooled 500 (the latest invoice has 99.00 of room).
 *
 * Each case logs its OBSERVED figures (`SA840 OBSERVED {...}`) so a run at the pre-fix base reports today's values.
 * Run with `npm run local:test:db` (fresh `rf_dbspec_*` database).
 */
import { describeDb } from "../common/testing/db-spec";
import { buildHarness, ONE_SHOT_150, type Harness } from "./sa840-multi-fixture";

describeDb(
  "SA-840 A-2 (F1): a refund is priced on what the lines already carry — real Postgres",
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await buildHarness("f1");
    }, 120_000);
    afterAll(async () => {
      await h?.cleanup();
    });

    const amountOf = (r: Awaited<ReturnType<Harness["refund"]>>): number => {
      if (!("amount" in r)) throw new Error(`refused: ${JSON.stringify(r.refused)}`);
      return r.amount;
    };
    const log = (o: Record<string, unknown>) => console.info(`SA840 OBSERVED ${JSON.stringify(o)}`);

    /** One-shot pooled 150 on a fresh identical order, by `method`. */
    async function oneShot(label: string, method: "CREDIT_NOTE" | "EXTERNAL_REFUND") {
      const s = await h.seed(`${label}-one`, { older: "B", smallerId: "B" });
      return amountOf(await h.refund(s, (await h.pooled(s, 150)).id, method));
    }

    it("R-F1: a pooled 50 then a pooled 100 sum to the one-shot pooled 150 (observed: the second lump was priced uncredited)", async () => {
      const s = await h.seed("rf1", { older: "B", smallerId: "B" });
      const r1 = await h.pooled(s, 50);
      const first = amountOf(await h.refund(s, r1.id));
      const r2 = await h.pooled(s, 100);
      const estimate = (await h.estimateOf(s, r2.id)).refundEstimate; // the detail figure for the second lump, before it is paid
      const second = amountOf(await h.refund(s, r2.id));
      const one = await oneShot("rf1", "CREDIT_NOTE");
      log({
        case: "R-F1",
        first,
        second,
        sum: h.round2(first + second),
        oneShot150: one,
        bound: ONE_SHOT_150,
        findOneEstimateOfSecond: estimate,
      });
      expect(h.round2(first + second)).toBe(one);
      expect(estimate).toBe(second); // detail = mint
    });

    it("R-F1b: 'line B 50' then a pooled 100 sum to the one-shot pooled 150", async () => {
      const s = await h.seed("rf1b", { older: "B", smallerId: "B" });
      const first = amountOf(await h.refund(s, (await h.onLine(s, "B", 50)).id));
      const second = amountOf(await h.refund(s, (await h.pooled(s, 100)).id));
      const one = await oneShot("rf1b", "CREDIT_NOTE");
      log({ case: "R-F1b", first, second, sum: h.round2(first + second), oneShot150: one });
      expect(h.round2(first + second)).toBe(one);
    });

    it("R-F1c: both pairs as EXTERNAL_REFUND — the recorded amounts sum to the one-shot", async () => {
      const one = await oneShot("rf1c", "EXTERNAL_REFUND");
      const a = await h.seed("rf1c-a", { older: "B", smallerId: "B" });
      const a1 = amountOf(await h.refund(a, (await h.pooled(a, 50)).id, "EXTERNAL_REFUND"));
      const a2 = amountOf(await h.refund(a, (await h.pooled(a, 100)).id, "EXTERNAL_REFUND"));
      const b = await h.seed("rf1c-b", { older: "B", smallerId: "B" });
      const b1 = amountOf(await h.refund(b, (await h.onLine(b, "B", 50)).id, "EXTERNAL_REFUND"));
      const b2 = amountOf(await h.refund(b, (await h.pooled(b, 100)).id, "EXTERNAL_REFUND"));
      log({
        case: "R-F1c",
        oneShot150: one,
        pooledThenPooled: [a1, a2, h.round2(a1 + a2)],
        lineThenPooled: [b1, b2, h.round2(b1 + b2)],
      });
      expect(h.round2(a1 + a2)).toBe(one);
      expect(h.round2(b1 + b2)).toBe(one);
    });

    it("G-F1d: ONE invoice — the mint stays itemised, and the detail estimate equals the mint once an earlier credit exists", async () => {
      const s = await h.seed("gf1d", { older: "B", smallerId: "B", invoices: 1 });
      const earlier = await h.refund(s, (await h.pooled(s, 100)).id);
      const next = await h.pooled(s, 100);
      const estimate = (await h.estimateOf(s, next.id)).refundEstimate;
      const minted = amountOf(await h.refund(s, next.id));
      const itemCount = await h.prisma.creditNoteItem.count({ where: { tenantId: s.tenantId } });
      log({
        case: "G-F1d",
        earlier: amountOf(earlier),
        findOneEstimate: estimate,
        minted,
        creditNoteItems: itemCount,
      });
      expect(itemCount).toBeGreaterThan(0); // itemised against the invoice's lines
      expect(estimate).toBe(minted);
    });

    it("G-F1d2: ONE invoice with an OPERATOR credit already on line A — the detail estimate equals the mint", async () => {
      const s = await h.seed("gf1d2", { older: "B", smallerId: "B", invoices: 1 });
      const note = await h.prisma.creditNote.create({
        data: {
          tenantId: s.tenantId,
          customerId: (await h.prisma.order.findUniqueOrThrow({ where: { id: s.orderId } }))
            .customerId,
          invoiceId: s.invA.id,
          creditNoteNumber: `CN-840-OP-${s.invA.id.slice(0, 8)}`,
          amount: 50,
          status: "ISSUED",
        },
      });
      await h.prisma.creditNoteItem.create({
        data: {
          tenantId: s.tenantId,
          creditNoteId: note.id,
          invoiceItemId: s.iA.id,
          amount: 50,
          qty: 200,
        },
      });
      const next = await h.pooled(s, 100);
      const estimate = (await h.estimateOf(s, next.id)).refundEstimate;
      const minted = amountOf(await h.refund(s, next.id));
      log({ case: "G-F1d2", findOneEstimate: estimate, minted });
      expect(estimate).toBe(minted);
    });

    // A RESOLVED return's detail estimate is priced against every OTHER credit (`own` leaves its own refund out), so it equals the
    // recorded refundAmount to the cent. A guard at the base (the read priced uncredited then); load-bearing against dropping `own`:
    // the return's own lump would then count as already carried and the estimate would price the NEXT slice of the lines.
    it.each([
      ["MULTI CREDIT_NOTE", 2, "CREDIT_NOTE"],
      ["MULTI EXTERNAL_REFUND", 2, "EXTERNAL_REFUND"],
      ["SINGLE CREDIT_NOTE", 1, "CREDIT_NOTE"],
    ] as const)(
      "G-F1f: %s — findOne's estimate for the resolved return equals its refundAmount",
      async (label, invoices, method) => {
        const s = await h.seed(`gf1f-${label.replace(/\W+/g, "-").toLowerCase()}`, {
          older: "B",
          smallerId: "B",
          invoices,
        });
        const ret = await h.pooled(s, 100);
        const minted = amountOf(await h.refund(s, ret.id, method));
        const row = await h.returnRow(ret.id);
        const estimate = (await h.estimateOf(s, ret.id)).refundEstimate;
        log({
          case: "G-F1f",
          label,
          minted,
          refundAmount: Number(row.refundAmount),
          findOneEstimate: estimate,
        });
        expect(Number(row.refundAmount)).toBe(minted);
        expect(estimate).toBe(Number(row.refundAmount));
      },
    );

    it("G-F1e: REG-B53 — the latest invoice's room (99.00) still refuses a MULTI pooled 500", async () => {
      const s = await h.seed("gf1e", { older: "B", smallerId: "B" });
      const r = await h.refund(s, (await h.pooled(s, 500)).id);
      log({ case: "G-F1e", result: r });
      expect(r).toMatchObject({ refused: { status: 400 } });
      expect((r as { refused: { message: string } }).refused.message).toMatch(/remaining room 99/);
      expect(await h.creditNoteCount(s)).toBe(0);
    });
  },
);
