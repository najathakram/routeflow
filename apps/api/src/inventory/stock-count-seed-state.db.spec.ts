/**
 * SA-999 (row 562 S1), real Postgres: a count whose seed has not finished is not committable.
 *
 *  (R1) a 450-line seed held after batch 1 by a barrier, then a commit from a second client: 409
 *       STOCK_COUNT_SEEDING and 0 movements (head 1a4181b3c: the commit took the lock between two batches and
 *       committed the 200 lines written so far). The seed then finishes: 450 lines, state "complete", and a
 *       commit goes through.
 *  (R2) a seed killed after batch 1 (the process died: no discard runs): the count stays "seeding" for good,
 *       never "complete"; a commit is 409 STOCK_COUNT_SEEDING; the existing discard turns it DISCARDED; a
 *       commit of a DISCARDED count is the existing 400.
 *  (R3) a seed that finishes commits all its lines (guard).
 *  (R4) a legacy row (both seed columns NULL) with lines commits (guard).
 *  (R5) a seed of 0 lines: planned 0, completed in the create, the progress read says "complete".
 *
 * These cases use behavior only (the service entry points, a spy on `tenantTransaction`), so they run on a head
 * without the columns too: the state is read through `any` and printed as "observed:" before it is asserted.
 */
import { describeDb } from "../common/testing/db-spec";
import { CountWorld, useCountDbHarness } from "./testing/count-db-harness";

describeDb("SA-999 - a count that is still being seeded cannot be committed", () => {
  const h = useCountDbHarness("stock-count-seed-state.db.spec");

  const codeOf = (e: any) => ({ status: e?.getStatus?.(), code: e?.getResponse?.()?.code });
  const settle = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ value }) as { value: T; err?: undefined },
      (err) => ({ err }) as { value?: undefined; err: any },
    );

  /** A COMMITTED source count of `n` products: an amendment of it seeds `n` lines. */
  async function committedSource(label: string, n: number): Promise<CountWorld> {
    const w = await h.seedCountWorld(label, n, { stock: 50, counted: (i) => i % 7 });
    await h.A.prisma.stockCountSession.update({
      where: { id: w.sessionId },
      data: { status: "COMMITTED", committedAt: new Date(), committedById: w.userId },
    });
    return w;
  }
  const amend = (w: CountWorld) =>
    h.inTenant(h.A, w, () =>
      h.A.inventory.startStockCountSession({ amendsSessionId: w.sessionId }, { sub: w.userId }),
    );
  /** The amendment session the seed created (it is not returned while the seed is held). */
  const amendmentOf = async (w: CountWorld): Promise<CountWorld> => {
    const s = await h.A.prisma.stockCountSession.findFirstOrThrow({
      where: { tenantId: w.tenantId, amendsSessionId: w.sessionId },
    });
    return { ...w, sessionId: s.id };
  };
  const linesOf = (w: CountWorld) =>
    h.A.prisma.stockCountLine.count({ where: { sessionId: w.sessionId } });
  const progressOf = async (w: CountWorld): Promise<any> =>
    h.inTenant(h.A, w, () => h.A.inventory.getStockCountProgress(w.sessionId));
  const rowOf = async (w: CountWorld): Promise<any> => h.sessionOf(w);
  const stateOf = async (w: CountWorld) => {
    const p = await progressOf(w);
    return { state: p.seedState, seeded: p.seeded, planned: p.planned, lineCount: p.lineCount };
  };

  /** Run `between` once, just before the seed's SECOND transaction (batch 2), on client A. */
  function beforeBatch2(between: () => Promise<unknown>, kill?: Error) {
    const original = h.A.prisma.tenantTransaction.bind(h.A.prisma) as any;
    let n = 0;
    jest.spyOn(h.A.prisma, "tenantTransaction").mockImplementation((async (fn: any, opts?: any) => {
      n += 1;
      if (n === 2) await between();
      // The kill: batch 2 never runs, and neither does the discard transaction that follows it.
      if (kill && n >= 2) throw kill;
      return original(fn, opts);
    }) as any);
  }

  it("(R1) a commit between batch 1 and 2 of a 450-line seed is 409 STOCK_COUNT_SEEDING, 0 movements", async () => {
    const w = await committedSource("r1", 450);
    let during: any;
    let stateDuring: any;
    let movementsDuring = -1;
    beforeBatch2(async () => {
      const a = await amendmentOf(w);
      stateDuring = await stateOf(a).catch((e) => ({ error: String(e?.message ?? e) }));
      during = await settle(h.commitSession(h.B, a));
      movementsDuring = (await h.countMovements(a)).length;
    });

    const started = await settle(amend(w));

    const a = await amendmentOf(w);
    console.log(
      `SA999-R1 observed: stateDuring=${JSON.stringify(stateDuring)} commitDuring=${
        during?.err ? JSON.stringify(codeOf(during.err)) : `applied=${during?.value?.applied}`
      } movementsDuring=${movementsDuring} seedResult=${
        started.err ? JSON.stringify(codeOf(started.err)) : "seeded"
      } lines=${await linesOf(a)} status=${(await rowOf(a)).status}`,
    );
    expect(stateDuring).toEqual({ state: "seeding", seeded: 200, planned: 450, lineCount: 200 });
    expect(codeOf(during?.err)).toEqual({ status: 409, code: "STOCK_COUNT_SEEDING" });
    expect(movementsDuring).toBe(0);
    // the seed was not disturbed: all 450 lines, still OPEN, stamped complete
    expect(started.err).toBeUndefined();
    expect(await linesOf(a)).toBe(450);
    expect((await rowOf(a)).status).toBe("OPEN");
    expect(await stateOf(a)).toEqual({
      state: "complete",
      seeded: 450,
      planned: 450,
      lineCount: 450,
    });
    // and now the commit goes through, all 450 lines
    const after = await h.commitSession(h.B, a);
    expect(after.applied).toBe(450);
    expect(await h.countMovements(a)).toHaveLength(450);
  }, 180_000);

  it("(R2) a seed killed after batch 1 stays 'seeding': 409 on commit, discardable, then the existing 400", async () => {
    const w = await committedSource("r2", 450);
    beforeBatch2(async () => undefined, new Error("process killed mid-seed"));

    const started = await settle(amend(w));
    jest.restoreAllMocks();

    const a = await amendmentOf(w);
    const state = await stateOf(a).catch((e) => ({ error: String(e?.message ?? e) }));
    const row = await rowOf(a);
    const commit = await settle(h.commitSession(h.B, a));
    const movements = (await h.countMovements(a)).length;
    const discard = await settle(
      h.inTenant(h.B, a, () => h.B.inventory.discardStockCountSession(a.sessionId)),
    );
    const afterDiscard = await settle(h.commitSession(h.B, a));
    console.log(
      `SA999-R2 observed: startErr=${started.err?.message} state=${JSON.stringify(state)} rowStatus=${
        row.status
      } seedCompletedAt=${row.seedCompletedAt ?? null} commit=${
        commit.err ? JSON.stringify(codeOf(commit.err)) : `applied=${commit.value?.applied}`
      } movements=${movements} discard=${
        discard.err ? JSON.stringify(codeOf(discard.err)) : (discard.value as any)?.status
      } commitAfterDiscard=${
        afterDiscard.err ? JSON.stringify(codeOf(afterDiscard.err)) : "committed"
      }`,
    );
    expect(started.err?.message).toBe("process killed mid-seed");
    expect(state).toEqual({ state: "seeding", seeded: 200, planned: 450, lineCount: 200 });
    expect(row.seedCompletedAt ?? null).toBeNull(); // a crash never stamps "complete"
    expect(codeOf(commit.err)).toEqual({ status: 409, code: "STOCK_COUNT_SEEDING" });
    expect(movements).toBe(0);
    expect((discard.value as any)?.status).toBe("DISCARDED");
    expect(codeOf(afterDiscard.err).status).toBe(400); // "This count was discarded"
  }, 180_000);

  it("(R3) a seed that finishes commits all its lines (guard)", async () => {
    const w = await committedSource("r3", 250);

    const created: any = await amend(w);

    const a: CountWorld = { ...w, sessionId: created.id };
    const state = await stateOf(a);
    const commit = await settle(h.commitSession(h.B, a));
    console.log(
      `SA999-R3 observed: state=${JSON.stringify(state)} commit=${
        commit.err ? JSON.stringify(codeOf(commit.err)) : `applied=${commit.value?.applied}`
      }`,
    );
    expect(state).toEqual({ state: "complete", seeded: 250, planned: 250, lineCount: 250 });
    expect(commit.err).toBeUndefined();
    expect(commit.value?.applied).toBe(250);
    expect(await h.countMovements(a)).toHaveLength(250);
  }, 180_000);

  it("(R4) a legacy row (both seed columns NULL) with lines commits (guard)", async () => {
    const w = await h.seedCountWorld("r4", 5);
    const row = await rowOf(w);
    expect(row.seedPlannedLines ?? null).toBeNull();
    expect(row.seedCompletedAt ?? null).toBeNull();

    const state = await stateOf(w);
    const commit = await settle(h.commitSession(h.B, w));
    console.log(
      `SA999-R4 observed: state=${JSON.stringify(state)} commit=${
        commit.err ? JSON.stringify(codeOf(commit.err)) : `applied=${commit.value?.applied}`
      }`,
    );
    expect(state).toEqual({ state: "legacy", seeded: 5, planned: null, lineCount: 5 });
    expect(commit.err).toBeUndefined();
    expect(commit.value?.applied).toBe(5);
  }, 120_000);

  it("(R5) a 0-line seed: planned 0, completed in the create, the progress read says 'complete'", async () => {
    const w = await h.seedCountWorld("r5", 1, { lines: false });

    const created: any = await h.inTenant(h.A, w, () =>
      h.A.inventory.startStockCountSession({ name: "r5" }, { sub: w.userId }),
    );

    const a: CountWorld = { ...w, sessionId: created.id };
    const state = await stateOf(a).catch((e) => ({ error: String(e?.message ?? e) }));
    const row = await rowOf(a);
    console.log(
      `SA999-R5 observed: state=${JSON.stringify(state)} planned=${row.seedPlannedLines} completedAt=${
        row.seedCompletedAt ? "set" : "null"
      }`,
    );
    expect(state).toEqual({ state: "complete", seeded: 0, planned: 0, lineCount: 0 });
    expect(row.seedPlannedLines).toBe(0);
    expect(row.seedCompletedAt).toBeInstanceOf(Date);
  }, 120_000);
});
