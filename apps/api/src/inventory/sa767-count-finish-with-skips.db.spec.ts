/**
 * SA-767 L-2.4 item C (r-note 4 C) - "Finish with skips". Real Postgres, a real AuditService.
 *
 * A PARTLY committed count (some of its movements exist, not COMMITTED) whose remaining line points at
 * a product that is now a FAMILY (permanently uncountable): the plain commit still errors and writes
 * nothing new; `finishWithSkips: true` commits every other remaining line, skips the family, writes
 * exactly one `stock-count.line-skipped` audit row and one notes line, and ends COMMITTED once.
 *
 *  (C1) the red row above.
 *  (C2) the flag on a count with NO movement yet is refused (400): it is the escape for a partly
 *       saved count, not a way to drop lines from a fresh one.
 */
import { describeDb } from "../common/testing/db-spec";
import { useCountDbHarness } from "./testing/count-db-harness";

describeDb("SA-767 L-2.4 C - finish with skips", () => {
  const h = useCountDbHarness("sa767-count-finish-with-skips.db.spec");

  it("(C1) a partial session whose product became a FAMILY: the flag commits the rest, skips and records the family", async () => {
    const w = await h.seedCountWorld("c1", 3); // counted 90 of 100 each
    const [p1, p2, p3] = [w.idOf(1), w.idOf(2), w.idOf(3)];
    // batch 1 landed for p1 (applied in an earlier, interrupted run)
    await h.A.prisma.product.update({ where: { id: p1 }, data: { currentStock: 90 } });
    await h.A.prisma.stockMovement.create({
      data: {
        tenantId: w.tenantId,
        productId: p1,
        type: "ADJUSTMENT",
        quantity: -10,
        stockAfter: 90,
        reference: `STOCK_COUNT-${w.sessionId}`,
        performedById: w.userId,
      },
    });
    // p3 became a FAMILY afterwards (permanently uncountable)
    await h.A.prisma.product.update({ where: { id: p3 }, data: { kind: "FAMILY" } });

    const plain: any = await h.commitSession(h.A, w).catch((e) => ({ err: e }));
    const afterPlain = {
      movements: (await h.countMovements(w)).length,
      p2: await h.stockOfId(p2),
      status: (await h.sessionOf(w)).status,
      audits: await h.A.prisma.auditLog.count({
        where: { tenantId: w.tenantId, action: "stock-count.line-skipped" },
      }),
    };

    const res: any = await h
      .commitSession(h.A, w, { finishWithSkips: true })
      .catch((e) => ({ err: e }));
    const s = await h.sessionOf(w);
    const audits = await h.A.prisma.auditLog.findMany({
      where: { tenantId: w.tenantId, action: "stock-count.line-skipped" },
    });
    console.log(
      `SA-767(C1) observed: plain=${plain.err ? plain.err.status : "committed"} ` +
        `afterPlain=${JSON.stringify(afterPlain)} flagged=${res.err ? `err ${res.err.status}` : "committed"} ` +
        `status=${s.status} audits=${audits.length}`,
    );

    // without the flag: the permanent failure still errors and writes nothing new
    expect(plain.err?.status).toBe(400);
    expect(afterPlain).toEqual({ movements: 1, p2: 100, status: "OPEN", audits: 0 });
    // with the flag: p2 is counted, p3 is skipped and recorded, COMMITTED once
    expect(res.err).toBeUndefined();
    expect(res.skippedProducts).toEqual([
      expect.objectContaining({ productId: p3, reason: "PRODUCT_IS_FAMILY" }),
    ]);
    expect(await h.stockOfId(p1)).toBe(90); // not applied twice
    expect(await h.stockOfId(p2)).toBe(90);
    expect(await h.stockOfId(p3)).toBe(100); // untouched
    expect((await h.countMovements(w)).map((m) => m.productId).sort()).toEqual([p1, p2]);
    expect(s.status).toBe("COMMITTED");
    expect(s.committedAt).not.toBeNull();
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({
      sessionId: w.sessionId,
      productId: p3,
      reason: "PRODUCT_IS_FAMILY",
    });
    expect(s.notes ?? "").toContain(p3);
    expect((s.notes ?? "").split("\n").filter((l) => l.includes(p3))).toHaveLength(1);

    // a further commit is the already-committed outcome and writes nothing
    const again: any = await h.commitSession(h.A, w, { finishWithSkips: true });
    expect(again.alreadyCommitted).toBe(true);
    expect(
      await h.A.prisma.auditLog.count({
        where: { tenantId: w.tenantId, action: "stock-count.line-skipped" },
      }),
    ).toBe(1);
  }, 90_000);

  it("(C2) the flag on a count with no movement yet is refused (400); nothing is skipped or written", async () => {
    const w = await h.seedCountWorld("c2", 2);
    await h.A.prisma.product.update({ where: { id: w.idOf(2) }, data: { kind: "FAMILY" } });

    const res: any = await h
      .commitSession(h.A, w, { finishWithSkips: true })
      .catch((e) => ({ err: e }));

    expect(res.err?.status).toBe(400);
    expect(await h.countMovements(w)).toHaveLength(0);
    expect(await h.stockOfId(w.idOf(1))).toBe(100);
    expect((await h.sessionOf(w)).status).toBe("OPEN");
  }, 60_000);
});
