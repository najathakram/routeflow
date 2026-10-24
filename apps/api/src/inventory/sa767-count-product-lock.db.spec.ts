/**
 * SA-767 r-note 5, SA-3 option (a) - ONE OPEN COUNT PER PRODUCT. Real Postgres.
 *
 *  (P1) session B adding a product that is open in session A -> 409 PRODUCT_IN_OPEN_COUNT carrying A's
 *       id and name; nothing is created.
 *  (P2) a concurrent add of the same products from two sessions on two connection pools -> for every
 *       product exactly one add succeeds (the blocking tx lock `stock-count-product:<tenantId>:<productId>`
 *       serialises them; without it both pass the overlap check).
 *  (P3) a COMMITTED or DISCARDED session does not block an add; re-saving the same session's line is
 *       an edit, not an add.
 *  (P4) a LEGACY overlap present at commit (two open sessions already hold the product) -> the commit
 *       is 409 PRODUCT_IN_OPEN_COUNT listing it; zero movements, stock untouched, session still OPEN.
 *  (P5) amending a committed count whose product is open in another session -> 409.
 */
import { describeDb } from "../common/testing/db-spec";
import { useCountDbHarness } from "./testing/count-db-harness";

describeDb("SA-767 r-note 5 SA-3 - one open count per product", () => {
  const h = useCountDbHarness("sa767-count-product-lock.db.spec");

  it("(P1) session B adding a product open in A is a 409 with A's id and name", async () => {
    const a = await h.seedCountWorld("p1", 1, { lines: false });
    const p = a.idOf(1);
    await h.upsert(h.A, a, { productId: p, countedQty: 5 }); // A holds the product
    const b = await h.addSession(a, "Aisle B");

    const err: any = await h.upsert(h.A, b, { productId: p, countedQty: 3 }).catch((e) => e);

    expect(err?.getStatus?.()).toBe(409);
    const body = err.getResponse();
    expect(body.code).toBe("PRODUCT_IN_OPEN_COUNT");
    expect(body.sessionId).toBe(a.sessionId);
    expect(body.sessionName).toBe("sa767 p1");
    expect(await h.A.prisma.stockCountLine.count({ where: { sessionId: b.sessionId } })).toBe(0);
  }, 60_000);

  it("(P2) a concurrent add race of the same products from two sessions: exactly one wins each", async () => {
    const N = 8;
    const a = await h.seedCountWorld("p2", N, { lines: false });
    const b = await h.addSession(a, "Aisle B");

    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, k) => k + 1).flatMap((i) => [
        h.upsert(h.A, a, { productId: a.idOf(i), countedQty: 1 }),
        h.upsert(h.B, b, { productId: a.idOf(i), countedQty: 2 }),
      ]),
    );

    for (let i = 1; i <= N; i++) {
      // eslint-disable-next-line no-await-in-loop
      const holders = await h.A.prisma.stockCountLine.count({ where: { productId: a.idOf(i) } });
      expect(holders).toBe(1);
    }
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(N);
    for (const r of rejected) {
      expect(r.reason?.getStatus?.()).toBe(409);
      expect(r.reason.getResponse().code).toBe("PRODUCT_IN_OPEN_COUNT");
    }
  }, 120_000);

  it("(P3) a committed session does not block; re-saving your own line is an edit, not an add", async () => {
    const a = await h.seedCountWorld("p3", 2, { lines: false });
    const p1 = a.idOf(1);
    const p2 = a.idOf(2);
    await h.upsert(h.A, a, { productId: p1, countedQty: 100 });
    await h.upsert(h.A, a, { productId: p1, countedQty: 90 }); // an edit of the same session's line
    await h.commitSession(h.A, a); // A is COMMITTED
    const b = await h.addSession(a, "Aisle B");

    await h.upsert(h.A, b, { productId: p1, countedQty: 5 }); // fine: A is no longer open
    await h.A.prisma.stockCountLine.deleteMany({ where: { sessionId: b.sessionId } });
    await h.A.prisma.stockCountSession.update({
      where: { id: b.sessionId },
      data: { status: "DISCARDED" },
    });
    const c = await h.addSession(a, "Aisle C");
    await h.upsert(h.A, c, { productId: p2, countedQty: 5 });

    expect(await h.A.prisma.stockCountLine.count({ where: { sessionId: c.sessionId } })).toBe(1);
  }, 120_000);

  it("(P4) a LEGACY overlap at commit is a 409 listing it; zero movements, stock untouched, still OPEN", async () => {
    const a = await h.seedCountWorld("p4", 2); // two REPLACE lines, counted 90 of 100
    const b = await h.addSession(a, "Aisle B");
    await h.addLegacyLine(b, a.idOf(2)); // legacy: the product is open in both sessions

    const err: any = await h.commitSession(h.A, a).catch((e) => e);

    expect(err?.getStatus?.()).toBe(409);
    const body = err.getResponse();
    expect(body.code).toBe("PRODUCT_IN_OPEN_COUNT");
    expect(body.conflicts).toEqual([
      {
        productId: a.idOf(2),
        productName: expect.any(String),
        sessionId: b.sessionId,
        sessionName: "Aisle B",
      },
    ]);
    expect(await h.countMovements(a)).toHaveLength(0);
    expect(await h.stockOfId(a.idOf(1))).toBe(100);
    expect(await h.stockOfId(a.idOf(2))).toBe(100);
    expect((await h.sessionOf(a)).status).toBe("OPEN");
  }, 60_000);

  it("(P5) amending a committed count whose product is open in another session is a 409", async () => {
    const a = await h.seedCountWorld("p5", 1);
    await h.commitSession(h.A, a);
    const b = await h.addSession(a, "Aisle B");
    await h.addLegacyLine(b, a.idOf(1)); // open in B (the committed A no longer blocks)

    const err: any = await h
      .inTenant(h.A, a, () =>
        h.A.inventory.startStockCountSession({ amendsSessionId: a.sessionId }, { sub: a.userId }),
      )
      .catch((e) => e);

    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse().code).toBe("PRODUCT_IN_OPEN_COUNT");
  }, 60_000);
});
