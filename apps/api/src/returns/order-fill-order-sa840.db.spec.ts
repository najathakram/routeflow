/**
 * SA-840 A-2 (F2) on REAL Postgres: the refund pricer and the order pool fill an order's invoices in ONE order (createdAt, then
 * id), so the line a pooled lump was PRICED on is the line the pool CREDITS it to. Fixture: review-b's MULTI order
 * (`sa840-multi-fixture.ts`), with EXPLICIT invoice ids and createdAt so the id order is chosen, not drawn.
 *
 *   R-F2   A's invoice is the NEWER one and has the SMALLER id. A pooled 100 pcs is refunded (priced on B, the older invoice's
 *          line), then a "line B 50" return is received and refunded. Before A-2 the pool replayed the lump onto A (id order), so
 *          B 50 passed the refusal and was paid: 150 pcs refunded for more than the 39.38 the lines are worth. After: 409
 *          RETURN_REFUND_OVER_LINE_HEADROOM, no second credit note, the return stays RECEIVED.
 *   G-F2b  the id order matches createdAt (B older, B has the smaller id): refused before and after.
 *   G-F2c  B on the NEWER invoice (A older, smaller id): A-2 says "B 50" is allowed; OBSERVED it is refused 400 by the latest invoice's
 *          room (2.25 left of B's 27.00 after the pooled lump landed there), before and after. See the case's comment.
 *
 * Each case logs its OBSERVED figures (`SA840 OBSERVED {...}`) so a run at the pre-fix base reports today's values.
 * Run with `npm run local:test:db` (fresh `rf_dbspec_*` database).
 */
import { describeDb } from "../common/testing/db-spec";
import { buildHarness, ONE_SHOT_150, type Harness } from "./sa840-multi-fixture";

describeDb(
  "SA-840 A-2 (F2): one fill order for the refund pricer and the order pool — real Postgres",
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await buildHarness("f2");
    }, 120_000);
    afterAll(async () => {
      await h?.cleanup();
    });

    const OVER_HEADROOM = "RETURN_REFUND_OVER_LINE_HEADROOM";

    /** pooled 100, then "line B 50"; returns what each refund did. */
    async function pooledThenLineB(label: string, older: "A" | "B", smallerId: "A" | "B") {
      const s = await h.seed(label, { older, smallerId });
      const first = await h.refund(s, (await h.pooled(s, 100)).id);
      const second = await h.onLine(s, "B", 50);
      const out = await h.refund(s, second.id);
      const row = await h.returnRow(second.id);
      const observed = {
        case: label,
        pooled100: "amount" in first ? first.amount : first.refused,
        lineB50: "amount" in out ? out.amount : out.refused,
        sum: "amount" in first && "amount" in out ? h.round2(first.amount + out.amount) : null,
        bound150: ONE_SHOT_150,
        returnStatus: row.status,
        creditNotes: await h.creditNoteCount(s),
      };
      console.info(`SA840 OBSERVED ${JSON.stringify(observed)}`);
      return { first, out, row, s };
    }

    it("R-F2: A's NEWER invoice has the SMALLER id — a pooled 100 then 'line B 50' is refused 409, no second credit note, the return stays RECEIVED", async () => {
      const { first, out, row, s } = await pooledThenLineB("rf2", "B", "A");
      expect(first).toMatchObject({ amount: expect.any(Number) });
      expect(out).toMatchObject({ refused: { status: 409, code: OVER_HEADROOM } });
      expect(row.status).toBe("RECEIVED");
      expect(row.creditNoteId).toBeNull();
      expect(await h.creditNoteCount(s)).toBe(1); // the pooled 100's note only
    });

    it("G-F2b: the id order matches createdAt (B older with the smaller id) — refused before and after", async () => {
      const { out, row } = await pooledThenLineB("gf2b", "B", "B");
      expect(out).toMatchObject({ refused: { status: 409, code: OVER_HEADROOM } });
      expect(row.status).toBe("RECEIVED");
    });

    // OBSERVED, not A-2's prediction: with B on the NEWER invoice the pooled 100 (24.75, priced on A, the older invoice's line) is
    // still minted as ONE lump on the LATEST invoice, B's (27.00), leaving 2.25 of room there, so "B 50" (13.50) is refused 400 by the
    // latest-invoice room check at the base AND after A-2. A-2 words this case as "allowed"; the spec follows the code and the
    // difference is reported to the lead (SA to rule: is the latest-invoice room gate the intended answer here?).
    it("G-F2c (observed): B on the NEWER invoice — 'B 50' is refused 400 by the LATEST invoice's room, before and after; no second credit note", async () => {
      const { first, out, row, s } = await pooledThenLineB("gf2c", "A", "A");
      expect(first).toMatchObject({ amount: 24.75 });
      expect(out).toMatchObject({
        refused: { status: 400, message: expect.stringMatching(/remaining room 2.25/) },
      });
      expect(row.status).toBe("RECEIVED");
      expect(await h.creditNoteCount(s)).toBe(1);
    });
  },
);
