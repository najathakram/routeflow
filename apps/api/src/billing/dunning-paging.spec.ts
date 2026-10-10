import { forEachRotated } from "./dunning-paging";

/**
 * The rotating keyset pager the reconciler (hourly) and the discovery sweep (daily) share. A run reads bounded
 * keyset pages; over budget it starts at a rotating row and wraps; and (Opus re-review) when the TIME budget cuts a
 * run short the next run starts where this one actually stopped, so the tail is never starved.
 */
function fakePrisma(ids: string[]) {
  const rows = ids.map((tenantId) => ({
    tenantId,
    stripeSubId: `sub_${tenantId}`,
    externalPayment: false,
    catchupState: null,
  }));
  return {
    tenantSubscription: {
      count: jest.fn(async () => rows.length),
      findMany: jest.fn(async (a: any) => {
        let r = [...rows].sort((x, y) => (x.tenantId < y.tenantId ? -1 : 1));
        const w = a?.where?.tenantId;
        if (w?.gt) r = r.filter((x) => x.tenantId > w.gt);
        if (w?.lte) r = r.filter((x) => x.tenantId <= w.lte);
        if (a?.skip) r = r.slice(a.skip);
        if (a?.take) r = r.slice(0, a.take);
        return r;
      }),
    },
  } as any;
}
const IDS = ["t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09", "t10"];
const HOUR = 3_600_000;
const T0 = new Date("2026-11-10T10:00:00Z");

async function run(
  prisma: any,
  at: Date,
  opts: Partial<Parameters<typeof forEachRotated>[3]> = {},
  clockState?: { t: number },
) {
  const seen: string[] = [];
  const clock = clockState ? () => clockState.t : undefined;
  const n = await forEachRotated(
    prisma,
    {},
    at,
    { maxRows: 100, batchSize: 4, timeBudgetMs: 60_000, unitMs: HOUR, clock, ...opts },
    async (r) => {
      seen.push(r.tenantId);
      if (clockState) clockState.t++;
    },
  );
  return { seen, n };
}

describe("forEachRotated", () => {
  it("reads the whole population once, in bounded keyset pages", async () => {
    const prisma = fakePrisma(IDS);
    const { seen, n } = await run(prisma, T0);
    expect(seen).toEqual(IDS);
    expect(n).toBe(10);
    expect(prisma.tenantSubscription.findMany.mock.calls.every((c: any[]) => c[0].take <= 4)).toBe(
      true,
    );
  });

  it("over the row budget: a run visits exactly `budget` rows, each once, and successive hours cover everyone", async () => {
    const union = new Set<string>();
    for (let h = 0; h < 5; h++) {
      const { seen } = await run(fakePrisma(IDS), new Date(T0.getTime() + h * HOUR), {
        maxRows: 4,
      });
      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4);
      seen.forEach((x) => union.add(x));
    }
    expect([...union].sort()).toEqual(IDS);
  });

  it("the start wraps past the end of the keyset", async () => {
    let wrapped = false;
    for (let h = 0; h < 10 && !wrapped; h++) {
      const { seen } = await run(fakePrisma(IDS), new Date(T0.getTime() + h * HOUR), {
        maxRows: 4,
      });
      wrapped = seen.includes("t10") && seen.includes("t01");
    }
    expect(wrapped).toBe(true);
  });

  describe("starvation: the TIME budget runs out before the row budget", () => {
    // 10 rows, no row cap, but a run can only afford 3 rows of work (a slow Stripe)
    const slow = { maxRows: 100, timeBudgetMs: 3 };

    it("WITHOUT memory the tail is never reached (the failure this guards): every run restarts at row 1", async () => {
      const union = new Set<string>();
      for (let h = 0; h < 6; h++) {
        const { seen } = await run(fakePrisma(IDS), new Date(T0.getTime() + h * HOUR), slow, {
          t: 0,
        });
        seen.forEach((x) => union.add(x));
      }
      expect([...union].sort()).toEqual(["t01", "t02", "t03"]);
    });

    it("WITH the process-local cursor each run starts where the last stopped, so every row is reached", async () => {
      const cursors = new Map<string, number>();
      const union = new Set<string>();
      const runs: string[][] = [];
      for (let h = 0; h < 4; h++) {
        const { seen } = await run(
          fakePrisma(IDS),
          new Date(T0.getTime() + h * HOUR),
          { ...slow, cursors, cursorKey: "reconcile" },
          { t: 0 },
        );
        runs.push(seen);
        seen.forEach((x) => union.add(x));
      }
      expect(runs[0]).toEqual(["t01", "t02", "t03"]);
      expect(runs[1]).toEqual(["t04", "t05", "t06"]);
      expect(runs[3]).toEqual(["t10", "t01", "t02"]); // wrapped
      expect([...union].sort()).toEqual(IDS);
    });

    it("the cursor advances by the rows actually PROCESSED (zero processed = no advance)", async () => {
      const cursors = new Map<string, number>();
      await run(
        fakePrisma(IDS),
        T0,
        { maxRows: 100, timeBudgetMs: 0, cursors, cursorKey: "k" },
        { t: 5 },
      );
      expect(cursors.get("k") ?? 0).toBe(0);
    });

    it("two sweeps keep separate cursors", async () => {
      const cursors = new Map<string, number>();
      await run(fakePrisma(IDS), T0, { ...slow, cursors, cursorKey: "a" }, { t: 0 });
      const { seen } = await run(
        fakePrisma(IDS),
        T0,
        { ...slow, cursors, cursorKey: "b" },
        { t: 0 },
      );
      expect(seen).toEqual(["t01", "t02", "t03"]);
    });
  });
});
