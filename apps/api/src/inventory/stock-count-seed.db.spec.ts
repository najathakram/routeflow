/**
 * Row 562 S1 (T14), real Postgres: the batched line seeder behind a count amendment.
 *
 *  (S1) amending a 1,000-line count seeds the SAME 1,000 lines in 5 transactions of 200 (master: ONE
 *       transaction holding 1,000 advisory locks, a 15 s budget it cannot keep at 3.4k lines).
 *  (S2) a product that becomes taken by another open count AFTER the pre-check, in batch 4, refuses the
 *       whole amendment (409 PRODUCT_IN_OPEN_COUNT) and discards the new session with no lines left.
 *  (S3) two amenders of the same count at once: no deadlock, exactly one wins, the other is the 409.
 *  (S4) a COMMIT racing the seed (the committer holds the count lock; the count is already COMMITTED; a real
 *       commit lands between two batches): the seed is refused with 409 STOCK_COUNT_COMMITTING and no line
 *       is ever written to the COMMITTED session after the commit.
 *  (S5) a DISCARD racing the seed (already DISCARDED; a real discard lands between two batches): the same 409,
 *       and no line is written after the discard.
 */
import { Prisma } from "@prisma/client";
import { withAdvisoryLock } from "../common/db-locks";
import { describeDb } from "../common/testing/db-spec";
import { seedStockCountLines, type SeedLine } from "./stock-count-seed";
import { CountWorld, useCountDbHarness } from "./testing/count-db-harness";

describeDb("row 562 S1 - batched count line seeding", () => {
  const h = useCountDbHarness("stock-count-seed.db.spec");

  /** A COMMITTED source count of `n` products (lines straight to the table; the commit is not under test). */
  async function committedSource(label: string, n: number): Promise<CountWorld> {
    const w = await h.seedCountWorld(label, n, { stock: 50, counted: (i) => i % 7 });
    await h.A.prisma.stockCountSession.update({
      where: { id: w.sessionId },
      data: { status: "COMMITTED", committedAt: new Date(), committedById: w.userId },
    });
    return w;
  }
  const amend = (s: typeof h.A, w: CountWorld) =>
    h.inTenant(s, w, () =>
      s.inventory.startStockCountSession({ amendsSessionId: w.sessionId }, { sub: w.userId }),
    );

  it("(S1) amending 1,000 lines is 5 seeding transactions and the same lines", async () => {
    const w = await committedSource("s1", 1000);
    const tx = jest.spyOn(h.A.prisma, "tenantTransaction");

    const created: any = await amend(h.A, w);

    console.log(`row562-S1 observed: seedTransactions=${tx.mock.calls.length}`);
    expect(tx).toHaveBeenCalledTimes(5);
    const lines = await h.A.prisma.stockCountLine.findMany({ where: { sessionId: created.id } });
    expect(lines).toHaveLength(1000);
    // the same lines, each product once, counted as the source count had it (order is not asserted)
    const want = new Map(Array.from({ length: 1000 }, (_, i) => [w.idOf(i + 1), (i + 1) % 7]));
    expect(new Map(lines.map((l) => [l.productId, Number(l.countedQty)]))).toEqual(want);
    expect(lines.every((l) => Number(l.expectedQty) === 50 && l.mode === "REPLACE")).toBe(true);
    expect(lines.every((l) => l.tenantId === w.tenantId && l.countedById === w.userId)).toBe(true);
  }, 120_000);

  it("(S2) a conflict that appears in batch 4 refuses the whole amendment and discards the session", async () => {
    const w = await committedSource("s2", 1000);
    const other = await h.addSession(w, "Aisle 3");
    const original = h.A.prisma.tenantTransaction.bind(h.A.prisma) as any;
    let n = 0;
    jest.spyOn(h.A.prisma, "tenantTransaction").mockImplementation((async (fn: any, opts?: any) => {
      n += 1;
      // Seeding transaction 4 holds products 601-800: another count takes #650 just before it runs.
      if (n === 4) await h.addLegacyLine(other, w.idOf(650));
      return original(fn, opts);
    }) as any);

    const err: any = await amend(h.A, w).catch((e) => e);

    console.log(
      `row562-S2 observed: status=${err?.getStatus?.()} code=${err?.getResponse?.()?.code}`,
    );
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse().code).toBe("PRODUCT_IN_OPEN_COUNT");
    expect(err.getResponse().conflicts).toEqual([
      expect.objectContaining({ productId: w.idOf(650), sessionId: other.sessionId }),
    ]);
    const made = await h.A.prisma.stockCountSession.findMany({
      where: { tenantId: w.tenantId, amendsSessionId: w.sessionId },
    });
    expect(made).toHaveLength(1);
    expect(made[0].status).toBe("DISCARDED");
    expect(await h.A.prisma.stockCountLine.count({ where: { sessionId: made[0].id } })).toBe(0);
    // the source count and the other count are untouched
    expect(await h.A.prisma.stockCountLine.count({ where: { sessionId: w.sessionId } })).toBe(1000);
    expect(await h.A.prisma.stockCountLine.count({ where: { sessionId: other.sessionId } })).toBe(
      1,
    );
  }, 120_000);

  it("(S3) two amenders at once: no deadlock, exactly one wins, the other gets the 409", async () => {
    const w = await committedSource("s3", 400);

    const results = await Promise.allSettled([amend(h.A, w), amend(h.B, w)]);

    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason?.getStatus?.()).toBe(409);
    expect(lost[0].reason.getResponse().code).toBe("PRODUCT_IN_OPEN_COUNT");
    const open = await h.A.prisma.stockCountSession.findMany({
      where: { tenantId: w.tenantId, amendsSessionId: w.sessionId, status: "OPEN" },
      include: { _count: { select: { lines: true } } },
    });
    expect(open).toHaveLength(1);
    expect(open[0]._count.lines).toBe(400);
    expect(
      await h.A.prisma.stockCountLine.count({
        where: { tenantId: w.tenantId, session: { amendsSessionId: w.sessionId } },
      }),
    ).toBe(400);
  }, 120_000);

  describe("the seeder takes the session's count lock and checks it is OPEN (562 S1 review fold)", () => {
    const codeOf = (e: any) => ({ status: e?.getStatus?.(), code: e?.getResponse?.()?.code });
    const linesFor = (w: CountWorld, n: number): SeedLine[] =>
      Array.from({ length: n }, (_, i) => ({
        productId: w.idOf(i + 1),
        mode: "REPLACE" as const,
        countedQty: new Prisma.Decimal(7),
        boxes: null,
        pieces: null,
      }));
    const seed = (w: CountWorld, n: number, batchSize?: number) =>
      h.inTenant(h.A, w, () =>
        seedStockCountLines(h.A.prisma, {
          sessionId: w.sessionId,
          userId: w.userId,
          lines: linesFor(w, n),
          batchSize,
        }),
      );
    const lineIds = async (w: CountWorld) =>
      (await h.A.prisma.stockCountLine.findMany({ where: { sessionId: w.sessionId } }))
        .map((l) => l.productId)
        .sort();
    /** Run `between` once, just before the seeder's SECOND transaction (batch 2). */
    function beforeBatch2(between: () => Promise<unknown>) {
      const original = h.A.prisma.tenantTransaction.bind(h.A.prisma) as any;
      let n = 0;
      jest.spyOn(h.A.prisma, "tenantTransaction").mockImplementation((async (
        fn: any,
        opts?: any,
      ) => {
        n += 1;
        if (n === 2) await between();
        return original(fn, opts);
      }) as any);
    }

    it("(S4a) a committer holding the count lock refuses the seed: 409, zero lines", async () => {
      const w = await h.seedCountWorld("s4a", 3, { lines: false });

      const held = await withAdvisoryLock(
        { family: "stock-count", key: w.sessionId, mode: "try" },
        () =>
          seed(w, 3).then(
            (r) => ({ ok: r }),
            (e) => ({ err: e }),
          ),
      );

      const out: any = held.acquired ? held.value : null;
      const count = await h.A.prisma.stockCountLine.count({ where: { sessionId: w.sessionId } });
      console.log(
        `row562-S4a observed: result=${JSON.stringify(out?.err ? codeOf(out.err) : out)} lines=${count}`,
      );
      expect(held.acquired).toBe(true);
      expect(codeOf(out?.err)).toEqual({ status: 409, code: "STOCK_COUNT_COMMITTING" });
      expect(count).toBe(0);
    }, 60_000);

    it("(S4b) a COMMITTED session refuses the seed: 409, zero lines", async () => {
      const w = await h.seedCountWorld("s4b", 3, { lines: false });
      await h.A.prisma.stockCountSession.update({
        where: { id: w.sessionId },
        data: { status: "COMMITTED", committedAt: new Date(), committedById: w.userId },
      });

      const err: any = await seed(w, 3).catch((e) => e);

      const count = await h.A.prisma.stockCountLine.count({ where: { sessionId: w.sessionId } });
      console.log(
        `row562-S4b observed: result=${err?.getStatus ? JSON.stringify(codeOf(err)) : "seeded"} lines=${count}`,
      );
      expect(codeOf(err)).toEqual({ status: 409, code: "STOCK_COUNT_COMMITTING" });
      expect(count).toBe(0);
    }, 60_000);

    it("(S4c) a real commit landing between batch 1 and 2: batch 2 is refused, nothing is written after the commit", async () => {
      const w = await h.seedCountWorld("s4c", 3, { lines: false });
      beforeBatch2(() => h.commitSession(h.B, w));

      const err: any = await seed(w, 3, 1).catch((e) => e);

      const ids = await lineIds(w);
      console.log(
        `row562-S4c observed: result=${err?.getStatus ? JSON.stringify(codeOf(err)) : "seeded"} lines=${ids.length} status=${(await h.sessionOf(w)).status}`,
      );
      expect((await h.sessionOf(w)).status).toBe("COMMITTED");
      expect(codeOf(err)).toEqual({ status: 409, code: "STOCK_COUNT_COMMITTING" });
      expect(ids).toEqual([w.idOf(1)]); // batch 1 landed while the count was OPEN; the commit saw exactly it
    }, 60_000);

    it("(S5a) a DISCARDED session refuses the seed: 409, zero lines", async () => {
      const w = await h.seedCountWorld("s5a", 3, { lines: false });
      await h.inTenant(h.B, w, () => h.B.inventory.discardStockCountSession(w.sessionId));

      const err: any = await seed(w, 3).catch((e) => e);

      const count = await h.A.prisma.stockCountLine.count({ where: { sessionId: w.sessionId } });
      console.log(
        `row562-S5a observed: result=${err?.getStatus ? JSON.stringify(codeOf(err)) : "seeded"} lines=${count}`,
      );
      expect(codeOf(err)).toEqual({ status: 409, code: "STOCK_COUNT_COMMITTING" });
      expect(count).toBe(0);
    }, 60_000);

    it("(S5b) a real discard landing between batch 1 and 2: batch 2 is refused, nothing is written after the discard", async () => {
      const w = await h.seedCountWorld("s5b", 3, { lines: false });
      beforeBatch2(() =>
        h.inTenant(h.B, w, () => h.B.inventory.discardStockCountSession(w.sessionId)),
      );

      const err: any = await seed(w, 3, 1).catch((e) => e);

      const ids = await lineIds(w);
      console.log(
        `row562-S5b observed: result=${err?.getStatus ? JSON.stringify(codeOf(err)) : "seeded"} lines=${ids.length} status=${(await h.sessionOf(w)).status}`,
      );
      expect((await h.sessionOf(w)).status).toBe("DISCARDED");
      expect(codeOf(err)).toEqual({ status: 409, code: "STOCK_COUNT_COMMITTING" });
      expect(ids).toEqual([w.idOf(1)]);
    }, 60_000);
  });
});
