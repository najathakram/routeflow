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
import { describeDb, requireLocalDatabaseUrl } from "../../../common/testing/db-spec";
import { PrismaService } from "../../../prisma/prisma.service";
import { TenantContextService } from "../../../tenant/tenant-context.service";
import { CounterDrawerService } from "./counter-drawer.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../../scripts/lib/test-tenants.cjs");

const WS = "2026-10-08T04:00:00.000Z";

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
    const ws = "2026-10-09T04:00:00.000Z";
    const same = await Promise.allSettled([
      as("A", () => service.record({ windowStart: ws, amount: 80 } as never, operator)),
      as("A", () => service.record({ windowStart: ws, amount: 80 } as never, operator)),
    ]);
    expect(same.every((r) => r.status === "fulfilled")).toBe(true);
    expect(
      same.map((r) => (r as PromiseFulfilledResult<{ created: boolean }>).value.created).sort(),
    ).toEqual([false, true]);
    const diff = await Promise.allSettled([
      as("A", () =>
        service.record({ windowStart: "2026-10-10T04:00:00.000Z", amount: 80 } as never, operator),
      ),
      as("A", () =>
        service.record({ windowStart: "2026-10-10T04:00:00.000Z", amount: 90 } as never, operator),
      ),
    ]);
    expect(diff.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = diff.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(
      await raw.counterDrawerEvent.count({
        where: {
          tenantId: tenants.A,
          windowStart: { in: [new Date(ws), new Date("2026-10-10T04:00:00.000Z")] },
        },
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
    const ws = "2026-10-11T04:00:00.000Z";
    await as("A", () => service.record({ windowStart: ws, amount: 200 } as never, operator));
    const ev = await as("A", () =>
      service.correct(
        { windowStart: ws, amount: 150, reason: "Recounted the rolls" } as never,
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

  it("a failing audit insert rolls the amount back (one transaction)", async () => {
    const ws = "2026-10-12T04:00:00.000Z";
    await as("A", () => service.record({ windowStart: ws, amount: 200 } as never, operator));
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
            { windowStart: ws, amount: 10, reason: "Fail the audit" } as never,
            admin,
          ),
        ),
      ).rejects.toBeDefined();
    } finally {
      await raw.$executeRawUnsafe(`DROP TRIGGER "${fn}" ON "AuditLog"`);
      await raw.$executeRawUnsafe(`DROP FUNCTION "${fn}"()`);
    }
    const row = await raw.counterDrawerEvent.findFirst({
      where: { tenantId: tenants.A, registerKey: "main", windowStart: new Date(ws) },
    });
    expect(Number(row?.amount)).toBe(200);
    expect(row?.reason).toBeNull();
  });

  it("another tenant's admin cannot correct this tenant's event", async () => {
    await expect(
      as("B", () =>
        service.correct(
          { windowStart: "2026-10-11T04:00:00.000Z", amount: 5, reason: "Not my drawer" } as never,
          adminB,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
