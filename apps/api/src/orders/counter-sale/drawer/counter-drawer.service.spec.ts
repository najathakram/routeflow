import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { DenominationCount } from "@routeflow/types";
import type { JwtPayload } from "../../../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../../../common/api-error-codes";
import { AdminAuditAction } from "../../../platform-admin/audit-actions.constant";
import { CounterDrawerService } from "./counter-drawer.service";

/**
 * W-819 part 1, the drawer service: record (once per window, idempotent replay, race), read (with the counter's name),
 * correct (reason, same-transaction audit, CAS), tenant isolation and rounding. An in-memory fake stands in for Prisma; the
 * unique key and the transaction are proven on real Postgres by counter-drawer.db.spec.ts. Placeholders only (acme).
 */
const A = "tenant-a";
const B = "tenant-b";
const WS = "2026-10-24T04:00:00.000Z";
const tens = (n: number): DenominationCount[] => [{ kind: "bill", value: 10, count: n }];
const op = (tenantId = A, sub = "u-op"): JwtPayload =>
  ({ sub, username: "op-acme", role: "OPERATOR", tenantId }) as unknown as JwtPayload;
const admin = (tenantId = A): JwtPayload =>
  ({ sub: "u-admin", role: "TENANT_ADMIN", tenantId }) as unknown as JwtPayload;

function setup(tenant = A, counter: "optional" | "off" = "optional") {
  const rows: any[] = [];
  const audits: any[] = [];
  const log: string[] = [];
  let seq = 0;
  const matches = (r: any, w: any) =>
    Object.entries(w).every(([k, v]) =>
      v instanceof Date ? r[k] instanceof Date && r[k].getTime() === v.getTime() : r[k] === v,
    );
  const makeDb = (target: any[], auditTarget: any[], tag: string) => ({
    counterDrawerEvent: {
      findFirst: jest.fn(async ({ where }: any) => {
        const r = rows.find((x) => matches(x, where));
        return r ? { ...r } : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (
          rows.some(
            (x) =>
              x.tenantId === data.tenantId &&
              x.registerKey === data.registerKey &&
              x.windowStart.getTime() === data.windowStart.getTime() &&
              x.kind === data.kind,
          )
        ) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const row = {
          id: `e-${++seq}`,
          at: new Date("2026-10-24T13:00:00.000Z"),
          reason: null,
          denominations: null,
          ...data,
        };
        target.push(row);
        log.push(`${tag}:create`);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = target.filter((x) => matches(x, where));
        hit.forEach((x) => Object.assign(x, data));
        log.push(`${tag}:update`);
        return { count: hit.length };
      }),
    },
    user: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.tenantId === A && where.id === "u-op" ? { username: "op-acme" } : null,
      ),
    },
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        auditTarget.push(data);
        log.push(`${tag}:audit`);
        return data;
      }),
    },
  });
  const db = makeDb(rows, audits, "db");
  const prisma = {
    getTenantId: jest.fn(() => tenant),
    forTenant: jest.fn(() => db),
    // The fake transaction applies writes to a staging copy and publishes both stores only if the callback resolves.
    tenantTransaction: jest.fn(async (fn: any) => {
      const snapshot = rows.map((r) => ({ ...r }));
      const auditSnapshot = [...audits];
      const tx = makeDb(rows, audits, "tx");
      try {
        return await fn(tx);
      } catch (e) {
        rows.splice(0, rows.length, ...snapshot);
        audits.splice(0, audits.length, ...auditSnapshot);
        throw e;
      }
    }),
  };
  const capability = { get: jest.fn(async () => ({ counter })) };
  const service = new CounterDrawerService(prisma as never, capability as never);
  return { service, rows, audits, log, db };
}

describe("CounterDrawerService.record", () => {
  it("writes one OPENING_FLOAT with the tenant and user from the session, never the body", async () => {
    const { service, rows } = setup();
    const res = await service.record({ windowStart: WS, amount: 150 }, op());
    expect(res.created).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: A,
      registerKey: "main",
      kind: "OPENING_FLOAT",
      amount: 150,
      byId: "u-op",
    });
    expect(rows[0].windowStart.toISOString()).toBe(WS);
    expect(res.event).toMatchObject({ amount: 150, byId: "u-op", byName: "op-acme", reason: null });
  });

  it("stores the breakdown when its sum equals the amount, and refuses one that does not", async () => {
    const { service, rows } = setup();
    await service.record({ windowStart: WS, amount: 40, denominations: tens(4) }, op());
    expect(rows[0].denominations).toEqual(tens(4));
    await expect(
      setup().service.record({ windowStart: WS, amount: 50, denominations: tens(4) }, op()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("an identical amount in the same window replays the existing row (created: false), writing nothing", async () => {
    const { service, rows } = setup();
    const first = await service.record({ windowStart: WS, amount: 150 }, op());
    const again = await service.record({ windowStart: WS, amount: 150 }, op("tenant-a", "u-op"));
    expect(again.created).toBe(false);
    expect(again.event.id).toBe(first.event.id);
    expect(rows).toHaveLength(1);
  });

  it("a DIFFERENT amount in the same window is 409 COUNTER_FLOAT_ALREADY_COUNTED and changes nothing", async () => {
    const { service, rows } = setup();
    await service.record({ windowStart: WS, amount: 150 }, op());
    const err: any = await service.record({ windowStart: WS, amount: 100 }, op()).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe(API_ERROR_CODES.COUNTER_FLOAT_ALREADY_COUNTED);
    expect(rows[0].amount).toBe(150);
  });

  it("a second till losing the insert race (P2002) reads the winner: same amount replays, different is 409", async () => {
    const { service, rows, db } = setup();
    const winner = {
      id: "w-1",
      tenantId: A,
      registerKey: "main",
      windowStart: new Date(WS),
      kind: "OPENING_FLOAT",
      amount: 150,
      denominations: null,
      at: new Date(),
      byId: "u-other",
      reason: null,
    };
    // the pre-check sees nothing; the create then collides; the re-read finds the winner
    db.counterDrawerEvent.findFirst.mockResolvedValueOnce(null);
    db.counterDrawerEvent.create.mockImplementationOnce(async () => {
      rows.push(winner);
      throw Object.assign(new Error("unique"), { code: "P2002" });
    });
    const res = await service.record({ windowStart: WS, amount: 150 }, op());
    expect(res.created).toBe(false);
    expect(res.event.id).toBe("w-1");
  });

  it("another window, another register and another kind-of-day are separate rows", async () => {
    const { service, rows } = setup();
    await service.record({ windowStart: WS, amount: 150 }, op());
    await service.record({ windowStart: "2026-10-23T04:00:00.000Z", amount: 100 }, op());
    await service.record({ windowStart: WS, amount: 75, registerKey: "b" }, op());
    expect(rows).toHaveLength(3);
  });

  it("rounds to cents and refuses a fraction of a cent, a negative, and a huge float", async () => {
    const { service, rows } = setup();
    await service.record({ windowStart: WS, amount: 0.1 + 0.2 }, op()).catch(() => undefined);
    // 0.30000000000000004 is not whole cents: the strict validator refuses it, so nothing is written
    expect(rows).toHaveLength(0);
    await service.record({ windowStart: WS, amount: 120.5 }, op());
    expect(rows[0].amount).toBe(120.5);
    for (const bad of [-1, 0.001, 1_000_000.01, Number.NaN, "5" as unknown as number]) {
      await expect(
        setup().service.record({ windowStart: WS, amount: bad }, op()),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("refuses a future windowStart and a bad date", async () => {
    const { service } = setup();
    await expect(
      service.record({ windowStart: "2999-01-01T00:00:00.000Z", amount: 1 }, op()),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.record({ windowStart: "nope", amount: 1 }, op())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("is refused COUNTER_SALES_DISABLED for a tenant with counter sales off, and without a tenant", async () => {
    const off: any = await setup(A, "off")
      .service.record({ windowStart: WS, amount: 1 }, op())
      .catch((e) => e);
    expect(off).toBeInstanceOf(ForbiddenException);
    expect(off.getResponse().code).toBe(API_ERROR_CODES.COUNTER_SALES_DISABLED);
    await expect(
      setup(null as never).service.record({ windowStart: WS, amount: 1 }, op()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("CounterDrawerService.read", () => {
  it("is null until counted, then the event with the counter's name", async () => {
    const { service } = setup();
    expect((await service.read(undefined, WS)).event).toBeNull();
    await service.record({ windowStart: WS, amount: 150 }, op());
    const s = await service.read(undefined, WS);
    expect(s).toMatchObject({ registerKey: "main", windowStart: WS });
    expect(s.event).toMatchObject({ amount: 150, byName: "op-acme", kind: "OPENING_FLOAT" });
  });

  it("another tenant reads nothing of this tenant's event", async () => {
    const a = setup(A);
    await a.service.record({ windowStart: WS, amount: 150 }, op());
    // same store, different session tenant
    const asB = setup(B);
    asB.rows.push(...a.rows);
    expect((await asB.service.read(undefined, WS)).event).toBeNull();
  });
});

describe("CounterDrawerService.correct", () => {
  const fix = (over: Record<string, unknown> = {}) => ({
    windowStart: WS,
    amount: 120,
    reason: "Miscounted the rolls",
    ...over,
  });

  it("updates the amount, keeps who counted it, and writes COUNTER_FLOAT_CORRECTED {from,to,reason} in the SAME transaction", async () => {
    const { service, rows, audits, log } = setup();
    await service.record({ windowStart: WS, amount: 150, denominations: tens(15) }, op());
    log.length = 0;
    const ev = await service.correct(fix() as never, admin());
    expect(ev).toMatchObject({
      amount: 120,
      byId: "u-op",
      reason: "Miscounted the rolls",
      denominations: null,
    });
    expect(rows[0].amount).toBe(120);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenantId: A,
      userId: "u-admin",
      action: AdminAuditAction.COUNTER_FLOAT_CORRECTED,
      entityType: "CounterDrawerEvent",
      entityId: rows[0].id,
      meta: {
        registerKey: "main",
        windowStart: WS,
        kind: "OPENING_FLOAT",
        from: 150,
        to: 120,
        reason: "Miscounted the rolls",
      },
    });
    expect(log).toEqual(["tx:update", "tx:audit"]); // both inside the transaction, update first
  });

  it("a failing audit write rolls the correction back (no figure moves without its audit row)", async () => {
    const { service, rows } = setup();
    await service.record({ windowStart: WS, amount: 150 }, op());
    const orig = (service as any).prisma.tenantTransaction;
    (service as any).prisma.tenantTransaction = jest.fn(async (fn: any) =>
      orig(async (tx: any) => {
        tx.auditLog.create = jest.fn(async () => {
          throw new Error("audit down");
        });
        return fn(tx);
      }),
    );
    await expect(service.correct(fix() as never, admin())).rejects.toThrow("audit down");
    expect(rows[0].amount).toBe(150);
  });

  it("needs a real reason: blank, short or missing is 400 and writes nothing", async () => {
    const { service, rows, audits } = setup();
    await service.record({ windowStart: WS, amount: 150 }, op());
    for (const reason of ["", "   ", "abcd", undefined, "x".repeat(501)]) {
      await expect(service.correct(fix({ reason }) as never, admin())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(rows[0].amount).toBe(150);
    expect(audits).toHaveLength(0);
  });

  it("404 COUNTER_FLOAT_NOT_COUNTED when the window has no event; 400 when the amount is unchanged", async () => {
    const { service } = setup();
    const err: any = await service.correct(fix() as never, admin()).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.getResponse().code).toBe(API_ERROR_CODES.COUNTER_FLOAT_NOT_COUNTED);
    await service.record({ windowStart: WS, amount: 120 }, op());
    await expect(service.correct(fix() as never, admin())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("another tenant's admin cannot correct this tenant's event (404, nothing written)", async () => {
    const a = setup(A);
    await a.service.record({ windowStart: WS, amount: 150 }, op());
    const asB = setup(B);
    asB.rows.push(...a.rows);
    await expect(asB.service.correct(fix() as never, admin(B))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(asB.rows[0].amount).toBe(150);
    expect(asB.audits).toHaveLength(0);
  });

  it("a concurrent correction (the amount moved under us) is 409, not a silent overwrite", async () => {
    const { service, rows, audits } = setup();
    await service.record({ windowStart: WS, amount: 150 }, op());
    const orig = (service as any).prisma.tenantTransaction;
    (service as any).prisma.tenantTransaction = jest.fn(async (fn: any) =>
      orig(async (tx: any) => {
        const um = tx.counterDrawerEvent.updateMany;
        tx.counterDrawerEvent.updateMany = jest.fn(async (args: any) => {
          rows[0].amount = 99; // another admin got there first
          return um(args);
        });
        return fn(tx);
      }),
    );
    await expect(service.correct(fix() as never, admin())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(audits).toHaveLength(0);
  });
});
