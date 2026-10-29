import {
  blockedBackends,
  clearStatSnapshot,
  prismaQueryable,
  waitUntilBlocked,
  waitUntilBlockedBy,
  type Queryable,
} from "./blocked-wait";

/** Records every statement; `blocked` rows are returned once `clearsBeforeVisible` clears have run. */
function fakeDb(opts: { visibleAfterProbe?: number } = {}) {
  const log: string[] = [];
  let probes = 0;
  const db: Queryable = {
    async query(sql, params) {
      if (/pg_stat_clear_snapshot/.test(sql)) {
        log.push("clear");
        return { rows: [] };
      }
      probes += 1;
      log.push(`probe:${JSON.stringify(params ?? [])}`);
      const visible = opts.visibleAfterProbe !== undefined && probes >= opts.visibleAfterProbe;
      return { rows: visible ? [{ pid: "7", blockers: ["3"] }] : [] };
    },
  };
  return { db, log };
}

describe("blocked-wait", () => {
  it("clears the stats snapshot before EVERY probe, never after", async () => {
    const { db, log } = fakeDb({ visibleAfterProbe: 3 });
    const got = await waitUntilBlocked(db, { holderPid: 3, intervalMs: 1, timeoutMs: 1_000 });
    expect(got).toEqual([{ pid: 7, blockers: [3] }]);
    expect(log).toEqual(["clear", "probe:[3]", "clear", "probe:[3]", "clear", "probe:[3]"]);
  });

  it("casts the void snapshot clear to text so Prisma can deserialize it", async () => {
    const sql: string[] = [];
    await clearStatSnapshot({
      async query(q) {
        sql.push(q);
        return { rows: [] };
      },
    });
    expect(sql).toEqual(["SELECT pg_stat_clear_snapshot()::text"]);
  });

  it("returns [] on timeout and still probes at least once", async () => {
    const { db, log } = fakeDb();
    expect(await waitUntilBlocked(db, { holderPid: 3, timeoutMs: 0 })).toEqual([]);
    expect(log).toEqual(["clear", "probe:[3]"]);
  });

  it("until() stops the wait before any probe", async () => {
    const { db, log } = fakeDb({ visibleAfterProbe: 1 });
    expect(await waitUntilBlocked(db, { until: () => true })).toEqual([]);
    expect(log).toEqual([]);
  });

  it("waitUntilBlockedBy is a boolean over the same loop", async () => {
    expect(await waitUntilBlockedBy(fakeDb({ visibleAfterProbe: 1 }).db, 3)).toBe(true);
    expect(await waitUntilBlockedBy(fakeDb().db, 3, { timeoutMs: 0 })).toBe(false);
  });

  it("passes the holder and the excluded pids as parameters, not SQL text", async () => {
    const { db, log } = fakeDb();
    await blockedBackends(db, { holderPid: 3, excludePids: [9] });
    expect(log).toEqual(["clear", "probe:[3,[9]]"]);
  });

  it("atLeast waits for that many backends and reports the last list seen on timeout", async () => {
    const rows = [{ pid: 7, blockers: [3] }];
    const db: Queryable = {
      async query(sql) {
        return { rows: /pg_stat_clear_snapshot/.test(sql) ? [] : rows };
      },
    };
    expect(await waitUntilBlocked(db, { atLeast: 2, timeoutMs: 0 })).toHaveLength(1);
    expect(await waitUntilBlocked(db, { atLeast: 1, timeoutMs: 0 })).toHaveLength(1);
  });

  it("prismaQueryable spreads params and wraps the result as rows", async () => {
    const calls: unknown[][] = [];
    const q = prismaQueryable({
      async $queryRawUnsafe(sql: string, ...values: unknown[]) {
        calls.push([sql, ...values]);
        return [{ n: 1 }];
      },
    });
    expect(await q.query("SELECT $1, $2", [1, 2])).toEqual({ rows: [{ n: 1 }] });
    expect(calls).toEqual([["SELECT $1, $2", 1, 2]]);
  });
});
