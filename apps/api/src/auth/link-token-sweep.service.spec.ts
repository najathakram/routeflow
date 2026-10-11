import "reflect-metadata";

// The leader lock needs a real Postgres pool: stand in for it, run the tick body as the winner would.
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import * as fs from "fs";
import * as path from "path";
import { createMockPrisma } from "../testing/prisma-mock";
import {
  LINK_TOKEN_MODELS,
  LINK_TOKEN_RETENTION_DAYS,
  LINK_TOKEN_SWEEP_BATCH,
  LinkTokenSweepService,
  type LinkTokenModel,
} from "./link-token-sweep.service";

/**
 * The daily expired-link sweep covers all four single-use link tables (staff and buyer, email
 * verification and password reset). Each "table" is an in-memory list that applies the `where`
 * the sweep SENDS and throws on a shape it does not model.
 */
const NOW = new Date("2026-10-12T03:40:00.000Z");
const DAY = 86_400_000;

type Row = { id: string; expiresAt: Date };
type Where = { expiresAt?: { lt: Date }; AND?: Array<Where | { id: { in: string[] } }> };

function matches(r: Row, w: Where): boolean {
  if (w.AND) return w.AND.every((a) => ("id" in a ? a.id.in.includes(r.id) : matches(r, a)));
  if (w.expiresAt) return r.expiresAt < w.expiresAt.lt;
  throw new Error("unmodelled where");
}

function setup(seed: Partial<Record<LinkTokenModel, Row[]>> = {}) {
  const prisma = createMockPrisma() as any;
  const tables = {} as Record<LinkTokenModel, Row[]>;
  const calls: Array<{ model: LinkTokenModel; op: string; args: any }> = [];
  for (const model of LINK_TOKEN_MODELS) {
    const rows = (tables[model] = [...(seed[model] ?? [])]);
    prisma[model] = {
      findMany: jest.fn(async (args: { where: Where; take: number }) => {
        calls.push({ model, op: "findMany", args });
        return rows.filter((r) => matches(r, args.where)).slice(0, args.take);
      }),
      deleteMany: jest.fn(async (args: { where: Where }) => {
        calls.push({ model, op: "deleteMany", args });
        const gone = rows.filter((r) => matches(r, args.where));
        for (const g of gone) rows.splice(rows.indexOf(g), 1);
        return { count: gone.length };
      }),
    };
  }
  return { prisma, tables, calls, service: new LinkTokenSweepService(prisma) };
}

const row = (id: string, daysFromNow: number): Row => ({
  id,
  expiresAt: new Date(NOW.getTime() + daysFromNow * DAY),
});

describe("LinkTokenSweepService.sweep", () => {
  it("covers exactly the four link models", () => {
    expect([...LINK_TOKEN_MODELS].sort()).toEqual([
      "buyerEmailVerificationToken",
      "buyerPasswordResetToken",
      "passwordResetToken",
      "userEmailVerificationToken",
    ]);
  });

  it("deletes rows expired beyond the retention window in every model, and keeps the rest", async () => {
    const old = -(LINK_TOKEN_RETENTION_DAYS + 1);
    const seed = Object.fromEntries(
      LINK_TOKEN_MODELS.map((m) => [
        m,
        [
          row(`${m}-old`, old),
          row(`${m}-recent-expired`, -1), // inside the retention window: stays
          row(`${m}-live`, 1), // not yet expired: stays
        ],
      ]),
    ) as Record<LinkTokenModel, Row[]>;
    const t = setup(seed);

    const res = await t.service.sweep(NOW);

    expect(res).toEqual({
      userEmailVerificationToken: 1,
      passwordResetToken: 1,
      buyerEmailVerificationToken: 1,
      buyerPasswordResetToken: 1,
    });
    for (const m of LINK_TOKEN_MODELS) {
      expect(t.tables[m].map((r) => r.id).sort()).toEqual([`${m}-live`, `${m}-recent-expired`]);
    }
  });

  it("works in bounded batches per model until a batch comes back short", async () => {
    const many = Array.from({ length: LINK_TOKEN_SWEEP_BATCH * 2 + 3 }, (_, i) =>
      row(`u-${String(i).padStart(5, "0")}`, -30),
    );
    const t = setup({ userEmailVerificationToken: many });

    const res = await t.service.sweep(NOW);

    expect(res.userEmailVerificationToken).toBe(LINK_TOKEN_SWEEP_BATCH * 2 + 3);
    expect(t.tables.userEmailVerificationToken).toHaveLength(0);
    expect(t.prisma.userEmailVerificationToken.findMany).toHaveBeenCalledTimes(3);
    for (const [args] of t.prisma.userEmailVerificationToken.findMany.mock.calls) {
      expect(args.take).toBe(LINK_TOKEN_SWEEP_BATCH);
    }
  });

  it("deletes exactly the ids it selected, re-applying the predicate", async () => {
    const t = setup({ passwordResetToken: [row("p-1", -30)] });
    const rows = t.tables.passwordResetToken;
    t.prisma.passwordResetToken.findMany.mockImplementationOnce(async () => {
      const found = [...rows];
      rows[0].expiresAt = new Date(NOW.getTime() + DAY); // no longer stale before the delete
      return found;
    });

    const res = await t.service.sweep(NOW);

    expect(res.passwordResetToken).toBe(0);
    expect(rows).toHaveLength(1);
    const where = t.prisma.passwordResetToken.deleteMany.mock.calls[0][0].where as {
      AND: unknown[];
    };
    expect(where.AND).toContainEqual({ id: { in: ["p-1"] } });
  });

  it("an empty table is one select and no delete; the base client is used", async () => {
    const t = setup();
    await t.service.sweep(NOW);
    for (const m of LINK_TOKEN_MODELS) {
      expect(t.prisma[m].findMany).toHaveBeenCalledTimes(1);
      expect(t.prisma[m].deleteMany).not.toHaveBeenCalled();
    }
    expect(t.prisma.forTenant).not.toHaveBeenCalled();
    expect(t.prisma.tenantTransaction).not.toHaveBeenCalled();
  });
});

describe("the sweep is a LeaderCron job", () => {
  it("runs daily under the leader lock as auth.linkTokenSweep (never a bare @Cron)", () => {
    const src = fs.readFileSync(path.join(__dirname, "link-token-sweep.service.ts"), "utf8");
    expect(src).toMatch(/@LeaderCron\("\d+ \d+ \* \* \*", "auth\.linkTokenSweep"\)/);
    expect(src).not.toMatch(/@Cron\(/);
  });

  it("the scheduled entry logs counts only and runs the sweep", async () => {
    const t = setup({ userEmailVerificationToken: [row("secret-id", -30)] });
    const log = jest.spyOn(t.service["logger"], "log").mockImplementation(() => undefined);

    await t.service.runScheduled();

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/deleted 1 expired link rows/);
    expect(String(log.mock.calls[0][0])).not.toContain("secret-id");
  });
});
