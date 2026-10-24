import "reflect-metadata";

// The leader lock needs a real Postgres pool: stand in for it, run the tick body as the winner would.
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { COUNTER_PARK_SWEEP_RESUMED_HOURS } from "@routeflow/pricing";
import { CRON_LOCK_FAMILY } from "../../common/cron-lock";
import { createMockPrisma } from "../../testing/prisma-mock";
import { COUNTER_PARK_SWEEP_BATCH } from "./counter-park";
import { CounterParkSweepService } from "./counter-park.sweep";

/**
 * The hourly parked-cart sweep (SA-748): both predicates, bounded batches, the UNSCOPED client, a loop that ends.
 * The "table" is an in-memory list that applies the `where` the sweep SENDS (and throws on a shape it does not model).
 */
const NOW = new Date("2026-10-08T15:30:00.000Z");
const H = 3_600_000;

type Row = { id: string; tenantId: string; resumedAt: Date | null; expiresAt: Date };
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  tenantId: id.startsWith("b") ? "tenant-b" : "tenant-a",
  resumedAt: null,
  expiresAt: new Date(NOW.getTime() + 10 * H),
  ...over,
});

type Where = {
  OR?: Array<{ resumedAt?: { lt: Date }; expiresAt?: { lt: Date } }>;
  AND?: Array<Where | { id: { in: string[] } }>;
};
function matches(r: Row, w: Where): boolean {
  if (w.OR) {
    return w.OR.some((c) => {
      if (c.resumedAt) return r.resumedAt !== null && r.resumedAt < c.resumedAt.lt;
      if (c.expiresAt) return r.expiresAt < c.expiresAt.lt;
      throw new Error("unmodelled OR branch");
    });
  }
  if (w.AND) {
    return w.AND.every((a) => ("id" in a ? a.id.in.includes(r.id) : matches(r, a as Where)));
  }
  throw new Error("unmodelled where");
}

function setup(rows: Row[]) {
  const prisma = createMockPrisma();
  const findMany = jest.fn(async (args: { where: Where; take: number }) =>
    rows.filter((r) => matches(r, args.where)).slice(0, args.take),
  );
  const deleteMany = jest.fn(async (args: { where: Where }) => {
    const gone = rows.filter((r) => matches(r, args.where));
    for (const g of gone) rows.splice(rows.indexOf(g), 1);
    return { count: gone.length };
  });
  (prisma as never as Record<string, unknown>).counterParkedCart = { findMany, deleteMany };
  const service = new CounterParkSweepService(prisma as never);
  return { prisma, rows, findMany, deleteMany, service };
}

describe("CounterParkSweepService.sweep", () => {
  it("deletes a row resumed more than 24 h ago OR expired, and nothing else", async () => {
    const rows = [
      row("a-open"), // open, unexpired: stays
      row("a-resumed-old", {
        resumedAt: new Date(NOW.getTime() - (COUNTER_PARK_SWEEP_RESUMED_HOURS + 1) * H),
      }),
      row("a-resumed-recent", { resumedAt: new Date(NOW.getTime() - 2 * H) }), // retry window: stays
      row("a-expired", { expiresAt: new Date(NOW.getTime() - 1) }),
      row("b-expired", { expiresAt: new Date(NOW.getTime() - 5 * H) }), // another tenant: swept too (spans tenants)
      row("a-edge", { expiresAt: new Date(NOW.getTime()) }), // expiresAt == now: not yet past
    ];
    const t = setup(rows);
    const res = await t.service.sweep(NOW);
    expect(res).toEqual({ deleted: 3 });
    expect(rows.map((r) => r.id).sort()).toEqual(["a-edge", "a-open", "a-resumed-recent"]);
  });

  it("works in bounded batches until a batch comes back short", async () => {
    const rows = Array.from({ length: COUNTER_PARK_SWEEP_BATCH * 2 + 7 }, (_, i) =>
      row(`a-${String(i).padStart(5, "0")}`, { expiresAt: new Date(NOW.getTime() - H) }),
    );
    const t = setup(rows);
    const res = await t.service.sweep(NOW);
    expect(res.deleted).toBe(COUNTER_PARK_SWEEP_BATCH * 2 + 7);
    expect(rows).toHaveLength(0);
    for (const call of t.findMany.mock.calls) expect(call[0].take).toBe(COUNTER_PARK_SWEEP_BATCH);
    expect(t.findMany).toHaveBeenCalledTimes(3);
    expect(t.deleteMany).toHaveBeenCalledTimes(3);
  });

  it("deletes exactly the ids it selected, re-applying the predicate (a row that changed state is kept)", async () => {
    const rows = [row("a-1", { expiresAt: new Date(NOW.getTime() - H) })];
    const t = setup(rows);
    // between the select and the delete the row is no longer stale
    t.findMany.mockImplementationOnce(async () => {
      const found = [...rows];
      rows[0].expiresAt = new Date(NOW.getTime() + 5 * H);
      return found;
    });
    const res = await t.service.sweep(NOW);
    expect(res.deleted).toBe(0);
    expect(rows).toHaveLength(1);
    const where = t.deleteMany.mock.calls[0][0].where as { AND: unknown[] };
    expect(where.AND).toContainEqual({ id: { in: ["a-1"] } });
  });

  it("a batch that deletes nothing ends the loop (no endless re-select)", async () => {
    const rows = Array.from({ length: COUNTER_PARK_SWEEP_BATCH }, (_, i) =>
      row(`a-${i}`, { expiresAt: new Date(NOW.getTime() - H) }),
    );
    const t = setup(rows);
    t.deleteMany.mockResolvedValue({ count: 0 });
    await expect(t.service.sweep(NOW)).resolves.toEqual({ deleted: 0 });
    expect(t.findMany).toHaveBeenCalledTimes(1);
  });

  it("an empty table is one select and no delete", async () => {
    const t = setup([]);
    await expect(t.service.sweep(NOW)).resolves.toEqual({ deleted: 0 });
    expect(t.deleteMany).not.toHaveBeenCalled();
  });

  it("uses the base (unscoped) client: never forTenant(), never a tenant transaction", async () => {
    const t = setup([row("a-1", { expiresAt: new Date(NOW.getTime() - H) })]);
    await t.service.sweep(NOW);
    expect(t.prisma.forTenant).not.toHaveBeenCalled();
    expect(t.prisma.tenantTransaction).not.toHaveBeenCalled();
  });
});

describe("the sweep is a LeaderCron job", () => {
  it("runs hourly under the leader lock as counter.parkSweep (never a bare @Cron)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require("fs").readFileSync(`${__dirname}/counter-park.sweep.ts`, "utf8") as string;
    expect(src).toMatch(/@LeaderCron\("\d+ \* \* \* \*", "counter\.parkSweep"\)/);
    expect(src).not.toMatch(/@Cron\(/);
    expect(CRON_LOCK_FAMILY).toBe("cron");
  });

  it("the scheduled entry logs counts only and runs the sweep", async () => {
    const t = setup([row("a-1", { expiresAt: new Date(NOW.getTime() - H) })]);
    const log = jest.spyOn(t.service["logger"], "log").mockImplementation(() => undefined);
    await t.service.runScheduled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/deleted 1 parked-cart rows/);
    expect(String(log.mock.calls[0][0])).not.toContain("a-1");
  });
});
