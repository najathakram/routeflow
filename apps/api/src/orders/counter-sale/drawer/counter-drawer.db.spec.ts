/**
 * W-819 part 1 - the drawer event on real Postgres (the part no fake can prove):
 *   - the unique (tenant, register, window, kind) key is real: a duplicate insert is a P2002 / 23505, and the service turns two
 *     concurrent records of one window into one row (same amount replays, a different amount is 409);
 *   - the same window under another tenant or another register is a separate row;
 *   - the amount CHECK refuses a negative at the database;
 *   - the correction writes the new amount AND its COUNTER_FLOAT_CORRECTED audit row in one transaction, and rolls both back
 *     when the audit insert fails;
 *   - another tenant cannot read or correct this tenant's event; a Prisma-side windowStart round-trips to the same instant.
 *
 * Collected only by jest.db.config.js (`npm run local:test:db`, test tenants only). Slugs `qa-drawer-*` are approved by
 * assertTestTenant.
 */
jest.mock("../../../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import type { JwtPayload } from "../../../auth/jwt-payload.interface";
import { calendarDayBounds } from "../../../common/calendar-date";
import { waitUntilBlockedBy } from "../../../common/testing/blocked-wait";
import { describeDb, requireLocalDatabaseUrl } from "../../../common/testing/db-spec";
import { PrismaService } from "../../../prisma/prisma.service";
import { TenantContextService } from "../../../tenant/tenant-context.service";
import { lockCounterCloseExclusive } from "../day-close/day-close-lock";
import { CounterDrawerService } from "./counter-drawer.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../../scripts/lib/test-tenants.cjs");

// The register's OPEN window: no close yet, so it starts at the start of today in the tenant zone (UTC here: these tenants set none).
const WS = calendarDayBounds("UTC", new Date()).start.toISOString();

describeDb("counter drawer event on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: CounterDrawerService;
  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-drawer-a-${run}`, "counter-drawer.db.spec.ts");
  const slugB = assertTestTenant(`qa-drawer-b-${run}`, "counter-drawer.db.spec.ts");
  const tenants = { A: "", B: "" };
  const userIds: string[] = [];
  let operator!: JwtPayload;
  let admin!: JwtPayload;
  let adminB!: JwtPayload;

  const as = <T>(tenant: "A" | "B", fn: () => Promise<T>) => tenantCtx.run(tenants[tenant], fn);
  const record = (amount: number, over: Record<string, unknown> = {}, who: "A" | "B" = "A") =>
    as(who, () =>
      service.record(
        { windowStart: WS, amount, ...over } as never,
        who === "A" ? operator : adminB,
      ),
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 10 });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    service = new CounterDrawerService(prisma, {
      get: async () => ({ counter: "optional" }),
    } as never);
    tenants.A = (await raw.tenant.create({ data: { slug: slugA, name: `Drawer A ${slugA}` } })).id;
    tenants.B = (await raw.tenant.create({ data: { slug: slugB, name: `Drawer B ${slugB}` } })).id;
    const mk = async (tenant: "A" | "B", role: "OPERATOR" | "TENANT_ADMIN", tag: string) => {
      const u = await raw.user.create({
        data: {
          email: `${tag}-${run}@example.test`,
          username: `${tag}-${run}`,
          role,
          tenantId: tenants[tenant],
        },
      });
      userIds.push(u.id);
      return {
        sub: u.id,
        username: u.username,
        role,
        tenantId: tenants[tenant],
      } as unknown as JwtPayload;
    };
    operator = await mk("A", "OPERATOR", "op");
    admin = await mk("A", "TENANT_ADMIN", "admin");
    adminB = await mk("B", "TENANT_ADMIN", "adminb");
  }, 120_000);

  afterAll(async () => {
    const tenantList = Object.values(tenants);
    await raw.auditLog.deleteMany({ where: { tenantId: { in: tenantList } } });
    await raw.counterDrawerEvent.deleteMany({ where: { tenantId: { in: tenantList } } });
    await raw.counterDayClose.deleteMany({ where: { tenantId: { in: tenantList } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.tenant.deleteMany({ where: { id: { in: tenantList } } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("records once, reads it back with the counter's name, and keeps the window instant exactly", async () => {
    const res = await record(150);
    expect(res.created).toBe(true);
    const state = await as("A", () => service.read(undefined, WS));
    expect(state.event).toMatchObject({ amount: 150, byName: `op-${run}`, windowStart: WS });
  });

  it("the unique key is real: a raw duplicate insert is a unique violation", async () => {
    await expect(
      raw.counterDrawerEvent.create({
        data: {
          tenantId: tenants.A,
          registerKey: "main",
          windowStart: new Date(WS),
          kind: "OPENING_FLOAT",
          amount: 1,
          byId: operator.sub,
        },
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/P2002|23505/) });
  });

  it("two concurrent records of one window leave one row: same amount replays, a different amount is 409", async () => {
    const same = await Promise.allSettled([
      as("A", () =>
        service.record({ windowStart: WS, amount: 80, registerKey: "k1" } as never, operator),
      ),
      as("A", () =>
        service.record({ windowStart: WS, amount: 80, registerKey: "k1" } as never, operator),
      ),
    ]);
    expect(same.every((r) => r.status === "fulfilled")).toBe(true);
    expect(
      same.map((r) => (r as PromiseFulfilledResult<{ created: boolean }>).value.created).sort(),
    ).toEqual([false, true]);
    const diff = await Promise.allSettled([
      as("A", () =>
        service.record({ windowStart: WS, amount: 80, registerKey: "k2" } as never, operator),
      ),
      as("A", () =>
        service.record({ windowStart: WS, amount: 90, registerKey: "k2" } as never, operator),
      ),
    ]);
    expect(diff.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = diff.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(
      await raw.counterDrawerEvent.count({
        where: { tenantId: tenants.A, registerKey: { in: ["k1", "k2"] } },
      }),
    ).toBe(2);
  });

  it("the duplicate-insert path is forced for real: the pre-read misses, the INSERT hits the unique key, the winner decides", async () => {
    await record(100, { registerKey: "p" });
    // The service's first read of the event, taken inside its transaction under the close lock, is blinded, so it goes to
    // create() and Postgres itself raises the unique violation (the lock makes this branch a safety net, not the normal path).
    const orig = prisma.tenantTransaction.bind(prisma);
    let blinded = false;
    const spy = jest.spyOn(prisma, "tenantTransaction").mockImplementation(((
      fn: (tx: unknown) => Promise<unknown>,
      ...rest: unknown[]
    ) =>
      (orig as any)(
        (tx: any) => {
          const wrapped = new Proxy(tx, {
            get(t, k) {
              const v = t[k];
              if (k !== "counterDrawerEvent") return typeof v === "function" ? v.bind(t) : v;
              return new Proxy(v, {
                get(t2, k2) {
                  if (k2 === "findFirst") {
                    return async (args: unknown) => {
                      if (!blinded) {
                        blinded = true;
                        return null;
                      }
                      return t2.findFirst(args);
                    };
                  }
                  const f = t2[k2];
                  return typeof f === "function" ? f.bind(t2) : f;
                },
              });
            },
          });
          return fn(wrapped);
        },
        ...rest,
      )) as never);
    try {
      const same = await record(100, { registerKey: "p" });
      expect(blinded).toBe(true);
      expect(same.created).toBe(false);
      blinded = false;
      await expect(record(110, { registerKey: "p" })).rejects.toBeInstanceOf(ConflictException);
      expect(blinded).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(
      await raw.counterDrawerEvent.count({ where: { tenantId: tenants.A, registerKey: "p" } }),
    ).toBe(1);
  });

  it("the window must be the open one: window+1ms is refused, and a window a real CounterDayClose covers is final", async () => {
    await record(50, { registerKey: "w" });
    const plusOne = new Date(new Date(WS).getTime() + 1).toISOString();
    await expect(record(60, { registerKey: "w", windowStart: plusOne })).rejects.toMatchObject({
      response: { code: "COUNTER_FLOAT_WINDOW_NOT_OPEN" },
    });
    const end = new Date(new Date(WS).getTime() + 1000);
    const closeRow = await raw.counterDayClose.create({
      data: {
        tenantId: tenants.A,
        registerKey: "cl",
        day: new Date(WS),
        zone: "UTC",
        windowStart: new Date(WS),
        windowEnd: end,
        closedAt: end,
        expectedCash: 0,
        countedCash: 0,
        variance: 0,
        denominations: [],
        totals: {},
      },
    });
    expect(closeRow.id).toBeTruthy();
    await expect(record(70, { registerKey: "cl" })).rejects.toMatchObject({
      response: { code: "COUNTER_FLOAT_WINDOW_NOT_OPEN" },
    });
    await expect(
      record(70, { registerKey: "cl", windowStart: end.toISOString() }),
    ).resolves.toMatchObject({ created: true });
    expect(
      await raw.counterDrawerEvent.count({
        where: { tenantId: tenants.A, registerKey: { in: ["w", "cl"] } },
      }),
    ).toBe(2);
  });

  it("the same window under another tenant or another register is a separate row", async () => {
    await expect(record(60, {}, "B")).resolves.toMatchObject({ created: true });
    await expect(record(70, { registerKey: "b" })).resolves.toMatchObject({ created: true });
    expect((await as("B", () => service.read(undefined, WS))).event?.amount).toBe(60);
  });

  it("the database refuses a negative amount (CHECK), whatever writes it", async () => {
    await expect(
      raw.counterDrawerEvent.create({
        data: {
          tenantId: tenants.A,
          registerKey: "chk",
          windowStart: new Date(WS),
          kind: "OPENING_FLOAT",
          amount: -1,
          byId: operator.sub,
        },
      }),
    ).rejects.toBeDefined();
  });

  it("a correction writes the amount and its audit row together", async () => {
    await record(200, { registerKey: "c1" });
    const ev = await as("A", () =>
      service.correct(
        {
          windowStart: WS,
          registerKey: "c1",
          amount: 150,
          expectedAmount: 200,
          reason: "Recounted the rolls",
        } as never,
        admin,
      ),
    );
    expect(ev).toMatchObject({ amount: 150, byId: operator.sub, reason: "Recounted the rolls" });
    const audit = await raw.auditLog.findMany({
      where: { tenantId: tenants.A, action: "COUNTER_FLOAT_CORRECTED", entityId: ev.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].userId).toBe(admin.sub);
    expect(audit[0].meta).toMatchObject({ from: 200, to: 150, reason: "Recounted the rolls" });
  });

  it("a stale second admin is refused 409 COUNTER_FLOAT_CHANGED and the first correction stands", async () => {
    await record(200, { registerKey: "st" });
    const fix = (amount: number, expectedAmount: number, reason: string) =>
      as("A", () =>
        service.correct(
          { windowStart: WS, registerKey: "st", amount, expectedAmount, reason } as never,
          admin,
        ),
      );
    await fix(150, 200, "Admin one recount");
    await expect(fix(130, 200, "Admin two stale")).rejects.toMatchObject({
      response: { code: "COUNTER_FLOAT_CHANGED" },
    });
    const row = await raw.counterDrawerEvent.findFirst({
      where: { tenantId: tenants.A, registerKey: "st" },
    });
    expect(Number(row?.amount)).toBe(150);
    expect(row?.reason).toBe("Admin one recount");
    expect(
      await raw.auditLog.count({
        where: { tenantId: tenants.A, action: "COUNTER_FLOAT_CORRECTED", entityId: row?.id },
      }),
    ).toBe(1);
  });

  it("a failing audit insert rolls the amount back (one transaction)", async () => {
    await record(200, { registerKey: "c2" });
    // A throwaway trigger refuses exactly this audit row, so the update has already run when the audit insert fails.
    const fn = `rf_w819_fail_audit_${run}`;
    await raw.$executeRawUnsafe(
      `CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."action" = 'COUNTER_FLOAT_CORRECTED' AND NEW."meta"->>'reason' = 'Fail the audit' THEN RAISE EXCEPTION 'audit refused'; END IF; RETURN NEW; END $$`,
    );
    await raw.$executeRawUnsafe(
      `CREATE TRIGGER "${fn}" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`,
    );
    try {
      await expect(
        as("A", () =>
          service.correct(
            {
              windowStart: WS,
              registerKey: "c2",
              amount: 10,
              expectedAmount: 200,
              reason: "Fail the audit",
            } as never,
            admin,
          ),
        ),
      ).rejects.toBeDefined();
    } finally {
      await raw.$executeRawUnsafe(`DROP TRIGGER "${fn}" ON "AuditLog"`);
      await raw.$executeRawUnsafe(`DROP FUNCTION "${fn}"()`);
    }
    const row = await raw.counterDrawerEvent.findFirst({
      where: { tenantId: tenants.A, registerKey: "c2", windowStart: new Date(WS) },
    });
    expect(Number(row?.amount)).toBe(200);
    expect(row?.reason).toBeNull();
  });

  it("another tenant's admin cannot correct this tenant's event", async () => {
    await expect(
      as("B", () =>
        service.correct(
          {
            windowStart: WS,
            registerKey: "c1",
            amount: 5,
            expectedAmount: 150,
            reason: "Not my drawer",
          } as never,
          adminB,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ─── SA-1019: the float and the close serialise on one lock, and a closed window is final until reopened ─────────

  const closeRow = (registerKey: string) => {
    const end = new Date(new Date(WS).getTime() + 1000);
    return {
      tenantId: tenants.A,
      registerKey,
      day: new Date(WS),
      zone: "UTC",
      windowStart: new Date(WS),
      windowEnd: end,
      closedAt: end,
      expectedCash: 0,
      countedCash: 0,
      variance: 0,
      denominations: [],
      totals: {},
    };
  };
  const fixFloat = (registerKey: string, amount: number, expectedAmount: number) =>
    as("A", () =>
      service.correct(
        {
          windowStart: WS,
          registerKey,
          amount,
          expectedAmount,
          reason: "Recounted the rolls",
        } as never,
        admin,
      ),
    );

  it("a float of a closed window cannot be corrected (409 COUNTER_FLOAT_WINDOW_NOT_OPEN); row and audit stay as they were", async () => {
    const REG = `cc-${run}`;
    await record(200, { registerKey: REG });
    await raw.counterDayClose.create({ data: closeRow(REG) });
    await expect(fixFloat(REG, 150, 200)).rejects.toMatchObject({
      response: { code: "COUNTER_FLOAT_WINDOW_NOT_OPEN" },
    });
    const row = await raw.counterDrawerEvent.findFirstOrThrow({
      where: { tenantId: tenants.A, registerKey: REG },
    });
    expect(Number(row.amount)).toBe(200);
    expect(row.reason).toBeNull();
    expect(
      await raw.auditLog.count({
        where: { tenantId: tenants.A, action: "COUNTER_FLOAT_CORRECTED", entityId: row.id },
      }),
    ).toBe(0);
  });

  it("guard: close, reopen, correct works (a reopened window is correctable again)", async () => {
    const REG = `cr-${run}`;
    await record(200, { registerKey: REG });
    const closed = await raw.counterDayClose.create({ data: closeRow(REG) });
    await expect(fixFloat(REG, 150, 200)).rejects.toMatchObject({
      response: { code: "COUNTER_FLOAT_WINDOW_NOT_OPEN" },
    });
    await raw.counterDayClose.update({
      where: { id: closed.id },
      data: { reopenedAt: new Date(), reopenedById: admin.sub },
    });
    await expect(fixFloat(REG, 150, 200)).resolves.toMatchObject({ amount: 150 });
    const row = await raw.counterDrawerEvent.findFirstOrThrow({
      where: { tenantId: tenants.A, registerKey: REG },
    });
    expect(Number(row.amount)).toBe(150);
    expect(
      await raw.auditLog.count({
        where: { tenantId: tenants.A, action: "COUNTER_FLOAT_CORRECTED", entityId: row.id },
      }),
    ).toBe(1);
  });

  it("a record racing the close waits for it, then is refused: no float lands in a window the close just sealed", async () => {
    const REG = `rc-${run}`;
    // A: the close as the day close runs it - the EXCLUSIVE lock first, then the close row - held open until released.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let acquired!: (pid: number) => void;
    const hasLock = new Promise<number>((r) => (acquired = r));
    const closing = raw.$transaction(
      async (tx) => {
        await lockCounterCloseExclusive(tx as never, tenants.A, REG);
        const rows = (await tx.$queryRaw`SELECT pg_backend_pid() AS pid`) as Array<{ pid: number }>;
        await tx.counterDayClose.create({ data: closeRow(REG) });
        acquired(Number(rows[0].pid));
        await gate;
      },
      { timeout: 30_000 },
    );
    const closerPid = await hasLock;

    // B: the till records the float of the window A is closing, while A holds the lock.
    let settled = false;
    const recording = record(40, { registerKey: REG }).then(
      (value) => ({ value, err: undefined as any }),
      (err) => ({ value: undefined, err }),
    );
    void recording.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 750));
    expect(settled).toBe(false); // B is queued behind the close, not already written into its window
    await waitUntilBlockedBy(pool, closerPid, { timeoutMs: 5_000, intervalMs: 50 });
    release();
    await closing;

    const out = await recording;
    expect(out.err?.response?.code).toBe("COUNTER_FLOAT_WINDOW_NOT_OPEN");
    expect(
      await raw.counterDrawerEvent.count({ where: { tenantId: tenants.A, registerKey: REG } }),
    ).toBe(0);
  });
});
