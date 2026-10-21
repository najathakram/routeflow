/**
 * SA-767 L-2.4 item B (r-note 4 B) - the commit-lock protocol of a durable stock count. Real Postgres,
 * separate connections, deterministic interleaves (the committer's first batch tx is parked while it
 * still owns the session's exclusive `stock-count` advisory lock).
 *
 *  (B1) a line save / remove while the committer holds the lock is 409 STOCK_COUNT_COMMITTING (the old
 *       code allowed it: no movement exists until the first batch commits).
 *  (B2) an all-zero-delta session (counted == expected, so NO movement is ever written) is protected
 *       by the LOCK, not by the movements check: a discard during its commit is 409.
 *  (B3) a discard racing a commit never leaves stock adjusted under a DISCARDED session.
 *  (B4) a discard that finished BEFORE the committer took the lock: the commit is refused (400), no
 *       stock moves (regression guard).
 *  (B5) the xact-shared lock the edits take is the SAME key pair as the committer's exclusive lock
 *       (probed with a raw try-lock), and two edits never block each other.
 *  (B6) after the commit finished, an edit is refused on the status seen under the lock (400).
 */
import { describeDb } from "../common/testing/db-spec";
import { settleWithin, useCountDbHarness } from "./testing/count-db-harness";

describeDb("SA-767 L-2.4 B - the stock-count commit-lock protocol", () => {
  const h = useCountDbHarness("sa767-count-lock-protocol.db.spec");

  const codeOf = (r: any) => ({ status: r?.err?.status, code: r?.err?.response?.code });

  it("(B1) a line save / remove while the committer holds the lock is 409 STOCK_COUNT_COMMITTING", async () => {
    const w = await h.seedCountWorld("b1", 3);
    const gate = h.holdFirstTxOpen(h.A);
    const commit = h.commitSession(h.A, w);
    commit.catch(() => undefined);
    await gate.parked;

    const save: any = await settleWithin(
      h.upsert(h.B, w, { productId: w.idOf(2), countedQty: 1 }),
      8_000,
    );
    const remove: any = await settleWithin(
      h.inTenant(h.B, w, () => h.B.inventory.removeStockCountLine(w.sessionId, w.idOf(3))),
      8_000,
    );
    console.log(
      `SA-767(B1) observed: save=${JSON.stringify(codeOf(save))} remove=${JSON.stringify(codeOf(remove))}`,
    );
    gate.release();
    await commit;

    expect(codeOf(save)).toEqual({ status: 409, code: "STOCK_COUNT_COMMITTING" });
    expect(codeOf(remove)).toEqual({ status: 409, code: "STOCK_COUNT_COMMITTING" });
    expect(await h.A.prisma.stockCountLine.count({ where: { sessionId: w.sessionId } })).toBe(3);
    expect((await h.sessionOf(w)).status).toBe("COMMITTED");
  }, 90_000);

  it("(B2) an all-zero-delta session is protected by the lock: a discard during its commit is 409", async () => {
    const w = await h.seedCountWorld("b2", 2, { counted: () => 100 }); // counted == expected
    const gate = h.holdFirstTxOpen(h.A);
    const commit = h.commitSession(h.A, w);
    commit.catch(() => undefined);
    await gate.parked;

    const discard: any = await settleWithin(
      h.inTenant(h.B, w, () => h.B.inventory.discardStockCountSession(w.sessionId)),
      8_000,
    );
    const status = (await h.sessionOf(w)).status;
    console.log(`SA-767(B2) observed: discard=${JSON.stringify(codeOf(discard))} status=${status}`);
    gate.release();
    const res: any = await commit.catch((e) => ({ err: e }));

    expect(codeOf(discard)).toEqual({ status: 409, code: "STOCK_COUNT_COMMITTING" });
    expect(status).toBe("OPEN");
    expect(res.err).toBeUndefined();
    expect((await h.sessionOf(w)).status).toBe("COMMITTED");
    // never any movement: the movements check alone could not have seen this commit
    expect(await h.countMovements(w)).toHaveLength(0);
  }, 90_000);

  it("(B3) a discard racing a commit never leaves stock adjusted under a DISCARDED session", async () => {
    const w = await h.seedCountWorld("b3", 3); // counted 90 of 100: a real -10 each
    const gate = h.holdFirstTxOpen(h.A);
    const commit = h.commitSession(h.A, w);
    commit.catch(() => undefined);
    await gate.parked; // batch 1 ran, uncommitted: no movement is visible yet

    const discard: any = await settleWithin(
      h.inTenant(h.B, w, () => h.B.inventory.discardStockCountSession(w.sessionId)),
      8_000,
    );
    gate.release();
    await commit.catch(() => undefined);

    const s = await h.sessionOf(w);
    const moves = await h.countMovements(w);
    const stocks = [
      await h.stockOfId(w.idOf(1)),
      await h.stockOfId(w.idOf(2)),
      await h.stockOfId(w.idOf(3)),
    ];
    console.log(
      `SA-767(B3) observed: discard=${JSON.stringify(codeOf(discard))} status=${s.status} ` +
        `movements=${moves.length} stocks=${stocks.join(",")}`,
    );
    // the invariant: a DISCARDED session has no stock effect
    if (s.status === "DISCARDED") {
      expect(moves).toHaveLength(0);
      expect(stocks).toEqual([100, 100, 100]);
    }
    // and the protocol's answer: the discard lost, the commit won
    expect(codeOf(discard)).toEqual({ status: 409, code: "STOCK_COUNT_COMMITTING" });
    expect(s.status).toBe("COMMITTED");
    expect(stocks).toEqual([90, 90, 90]);
  }, 90_000);

  it("(B4) a discard that finished before the committer took the lock: the commit is refused, no stock moves", async () => {
    const w = await h.seedCountWorld("b4", 2);
    await h.inTenant(h.A, w, () => h.A.inventory.discardStockCountSession(w.sessionId));

    const res: any = await settleWithin(h.commitSession(h.A, w), 15_000);

    expect(res.err?.status).toBe(400);
    expect(await h.countMovements(w)).toHaveLength(0);
    expect(await h.stockOfId(w.idOf(1))).toBe(100);
    expect((await h.sessionOf(w)).status).toBe("DISCARDED");
  }, 60_000);

  it("(B5) the edits' shared lock is the committer's key pair, and two edits never block each other", async () => {
    const w = await h.seedCountWorld("b5", 3);
    const tryExclusive = async (): Promise<boolean> => {
      const client = await h.pool.connect();
      try {
        const { rows } = await client.query(
          "SELECT pg_try_advisory_lock(hashtext('stock-count'), hashtext($1)) AS ok",
          [w.sessionId],
        );
        if (rows[0].ok) await client.query("SELECT pg_advisory_unlock_all()");
        return rows[0].ok as boolean;
      } finally {
        client.release(true);
      }
    };

    // (i) an edit parked mid-tx holds the SHARED xact lock: an exclusive try on the same pair fails;
    //     a second edit on another connection is not blocked by it.
    const editGate = h.holdFirstTxOpen(h.A);
    const edit = h.upsert(h.A, w, { productId: w.idOf(1), countedQty: 5 });
    edit.catch(() => undefined);
    await editGate.parked;
    const exclusiveWhileEditing = await tryExclusive();
    const second: any = await settleWithin(
      h.upsert(h.B, w, { productId: w.idOf(2), countedQty: 7 }),
      8_000,
    );
    editGate.release();
    await edit;

    expect(exclusiveWhileEditing).toBe(false);
    expect(second).not.toBe("pending");
    expect(second.err).toBeUndefined();
    // (ii) once both edits ended nothing holds the pair
    expect(await tryExclusive()).toBe(true);
  }, 90_000);

  it("(B6) after the commit finished, a line edit is refused on the status seen under the lock", async () => {
    const w = await h.seedCountWorld("b6", 2);
    await h.commitSession(h.A, w);

    const res: any = await settleWithin(
      h.upsert(h.B, w, { productId: w.idOf(1), countedQty: 1 }),
      8_000,
    );

    expect(res.err?.status).toBe(400);
    const line = await h.A.prisma.stockCountLine.findFirstOrThrow({
      where: { sessionId: w.sessionId, productId: w.idOf(1) },
    });
    expect(Number(line.countedQty)).toBe(90);
  }, 60_000);
});
