/**
 * Row 562 S1 (T14), real Postgres: the batched line seeder behind a count amendment.
 *
 *  (S1) amending a 1,000-line count seeds the SAME 1,000 lines in 5 transactions of 200 (master: ONE
 *       transaction holding 1,000 advisory locks, a 15 s budget it cannot keep at 3.4k lines).
 *  (S2) a product that becomes taken by another open count AFTER the pre-check, in batch 4, refuses the
 *       whole amendment (409 PRODUCT_IN_OPEN_COUNT) and discards the new session with no lines left.
 *  (S3) two amenders of the same count at once: no deadlock, exactly one wins, the other is the 409.
 */
import { describeDb } from "../common/testing/db-spec";
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
});
