import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from "@nestjs/common";
import {
  COUNTER_PARK_MAX_BYTES,
  COUNTER_PARK_MAX_LINES,
  COUNTER_PARK_MAX_PER_REGISTER,
  COUNTER_PARK_MAX_PER_TENANT,
  COUNTER_PARK_RETRY_WINDOW_MS,
  COUNTER_PARK_TTL_HOURS,
} from "@routeflow/pricing";
import type { FulfilmentCapability } from "@routeflow/types";
import { deriveFulfilmentCapability } from "../../billing/fulfilment-capability";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { LOCK_FAMILIES } from "../../common/db-locks";
import { createMockPrisma, type MockPrisma } from "../../testing/prisma-mock";
import { CounterParkService } from "./counter-park.service";
import { priceLinesOf } from "./counter-park";
import { FakeParkDb } from "./counter-park.fixtures";

/**
 * Counter-sale PARK / RESUME (SA-748), the service. The raw SQL runs against `FakeParkDb`, an in-memory table that
 * applies the bound values the service sends (tenant, register, clock), so every assertion is about what was really
 * asked. Placeholders only (acme); no live-client data.
 */
const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";
const OP = { sub: "op-1", role: "OPERATOR" } as never;
const OP2 = { sub: "op-2", role: "OPERATOR" } as never;
/** Resume attempt ids (a uuid v4 each, minted per resume tap by the client). */
const A1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const B1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const NOW = new Date("2026-10-08T15:30:00.000Z"); // 11:30 in New York (EDT)
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const withCounter = (counter: FulfilmentCapability["counter"]): FulfilmentCapability => ({
  ...deriveFulfilmentCapability({ mode: "unset", counterSales: "unset", fleet: false }),
  counter,
});

const line = (over: Record<string, unknown> = {}) => ({
  tempId: "t-1",
  productId: "prod-1",
  name: "Acme Widget",
  unitPrice: 2.5,
  qty: 2,
  ...over,
});
const payload = (over: Record<string, unknown> = {}) => ({
  lines: [line()],
  customer: null,
  method: "CASH",
  tendered: "",
  reference: "",
  ...over,
});

function setup(opts: { counter?: FulfilmentCapability["counter"]; timezone?: string | null } = {}) {
  const db = new FakeParkDb();
  const prisma: MockPrisma = createMockPrisma();
  let tenant: string | null = TENANT;
  prisma.getTenantId.mockImplementation(() => tenant);
  (prisma as never as { $queryRaw: unknown }).$queryRaw = db.queryRaw;
  prisma.tenantTransaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $queryRaw: db.queryRaw, $executeRaw: db.executeRaw }),
  );
  prisma.tenantConfig.findUnique.mockResolvedValue(
    opts.timezone === null ? null : { timezone: opts.timezone ?? "America/New_York" },
  );
  const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
  prisma.forTenant.mockReturnValue({ counterParkedCart: { deleteMany } } as never);
  const capability = { get: jest.fn().mockResolvedValue(withCounter(opts.counter ?? "optional")) };
  const service = new CounterParkService(prisma as never, capability as never);
  return {
    db,
    prisma,
    capability,
    deleteMany,
    service,
    setTenant: (t: string | null) => (tenant = t),
    park: (over: Record<string, unknown> = {}, user = OP, now = NOW) =>
      service.park({ id: id(1), payload: payload(), ...over } as never, user, now),
  };
}

describe("CounterParkService.park", () => {
  it("a payload that names the server-reserved _resume key is 400, whatever its value, and nothing is stored", async () => {
    const t = setup();
    for (const v of [{ attemptId: A1 }, null, "x", 0]) {
      const e = await t.park({ payload: { ...payload(), _resume: v } }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(BadRequestException);
    }
    expect(t.db.rows).toHaveLength(0);
    expect(t.db.statements.some((s) => s.sql.startsWith("INSERT"))).toBe(false);
  });
  it("stores ONLY the rebuilt payload: unknown keys and a customer email are not in what is inserted", async () => {
    const t = setup();
    await t.park({
      payload: payload({
        lines: [line({ evil: "x", costPrice: 1.1 })],
        customer: { id: "c-1", businessName: "Acme Foods", email: "a@acme.test", pricingTier: 2 },
        sneaky: { a: 1 },
      }),
    });
    const stored = t.db.rows[0].payload as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(
      ["customer", "lines", "method", "reference", "tendered"].sort(),
    );
    expect(stored.customer).toEqual({ id: "c-1", businessName: "Acme Foods", pricingTier: 2 });
    expect((stored.lines as Array<Record<string, unknown>>)[0]).not.toHaveProperty("evil");
    expect((stored.lines as Array<Record<string, unknown>>)[0]).not.toHaveProperty("costPrice");
    const insert = t.db.statements.find((s) => s.sql.startsWith("INSERT"))!;
    expect(JSON.stringify(insert.values)).not.toContain("a@acme.test");
    expect(JSON.stringify(insert.values)).not.toContain("sneaky");
  });

  it("records payloadVersion 1, createdById = the actor, expiresAt = now + 24 h, in the caller's tenant", async () => {
    const t = setup();
    const res = await t.park({}, OP2);
    const row = t.db.rows[0];
    expect(row).toMatchObject({ tenantId: TENANT, createdById: "op-2", registerKey: "main" });
    expect(row.createdAt).toEqual(NOW);
    expect(row.expiresAt.getTime() - NOW.getTime()).toBe(COUNTER_PARK_TTL_HOURS * 3_600_000);
    expect(t.db.statements.find((s) => s.sql.startsWith("INSERT"))!.sql).toContain(
      '"payloadVersion"',
    );
    expect(t.db.statements.find((s) => s.sql.startsWith("INSERT"))!.sql).toMatch(/, 1, \?, \?\)/);
    expect(res).toMatchObject({
      id: id(1),
      registerKey: "main",
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 24 * 3_600_000).toISOString(),
      lineCount: 1,
      replayed: false,
    });
    expect(res).not.toHaveProperty("payload");
  });

  describe("labels", () => {
    it("defaults to 'Walk-in · HH:MM' (24 h) in the tenant's zone", async () => {
      const t = setup({ timezone: "America/New_York" });
      expect((await t.park()).label).toBe("Walk-in · 11:30");
    });
    it("falls back to UTC for a missing or unknown zone", async () => {
      expect((await setup({ timezone: null }).park()).label).toBe("Walk-in · 15:30");
      expect((await setup({ timezone: "Not/AZone" }).park()).label).toBe("Walk-in · 15:30");
    });
    it("defaults to the customer's business name when the payload has one", async () => {
      const t = setup();
      const res = await t.park({
        payload: payload({ customer: { id: "c-1", businessName: "Acme Foods" } }),
      });
      expect(res.label).toBe("Acme Foods");
      expect(res.customerName).toBe("Acme Foods");
    });
    it("truncates a long default to 60 characters", async () => {
      const t = setup();
      const res = await t.park({
        payload: payload({ customer: { id: "c-1", businessName: "A".repeat(150) } }),
      });
      expect(res.label).toHaveLength(60);
    });
    it("keeps a typed label, trimmed; a blank one means the default", async () => {
      const t = setup();
      expect((await t.park({ label: "  Aisle 3  " })).label).toBe("Aisle 3");
      const t2 = setup();
      expect((await t2.park({ label: "   " })).label).toBe("Walk-in · 11:30");
    });
  });

  it("uses a valid registerKey and the default register for none", async () => {
    const t = setup();
    expect((await t.park({ registerKey: "front-2" })).registerKey).toBe("front-2");
    expect((await t.park({ id: id(2) })).registerKey).toBe("main");
    // an invalid key never reaches the service (the DTO refuses it), but if it did it is the default, not stored raw
    expect((await t.park({ id: id(3), registerKey: "bad key!" })).registerKey).toBe("main");
    // the shared union pattern: a ':' is fine inside a key, never first
    expect((await t.park({ id: id(4), registerKey: "Front:1" })).registerKey).toBe("Front:1");
    expect((await t.park({ id: id(5), registerKey: ":front" })).registerKey).toBe("main");
  });

  describe("size caps", () => {
    it("201 lines => 413 and nothing is written", async () => {
      const t = setup();
      const lines = Array.from({ length: COUNTER_PARK_MAX_LINES + 1 }, (_, i) =>
        line({ tempId: `t-${i}` }),
      );
      await expect(t.park({ payload: payload({ lines }) })).rejects.toBeInstanceOf(
        PayloadTooLargeException,
      );
      expect(t.db.rows).toHaveLength(0);
      expect(t.prisma.tenantTransaction).not.toHaveBeenCalled();
    });
    it("200 lines is fine", async () => {
      const t = setup();
      const lines = Array.from({ length: COUNTER_PARK_MAX_LINES }, (_, i) =>
        line({ tempId: `t-${i}`, name: "n" }),
      );
      const bytes = Buffer.byteLength(JSON.stringify(lines));
      if (bytes > COUNTER_PARK_MAX_BYTES) throw new Error("fixture too big for this case");
      await expect(t.park({ payload: payload({ lines }) })).resolves.toBeDefined();
    });
    it("a rebuilt payload over 64 KB => 413", async () => {
      const t = setup();
      const lines = Array.from({ length: 150 }, (_, i) =>
        line({
          tempId: `t-${i}`,
          name: "N".repeat(200),
          note: "n".repeat(200),
          category: "c".repeat(100),
          override: { mode: "set", value: 1, reason: "r".repeat(500) },
        }),
      );
      await expect(t.park({ payload: payload({ lines }) })).rejects.toBeInstanceOf(
        PayloadTooLargeException,
      );
      expect(t.db.rows).toHaveLength(0);
    });
    it("a malformed payload => 400 with a fixed message that does not echo the input", async () => {
      const t = setup();
      const bad = [
        payload({ lines: [{ productId: "p", qty: "two", unitPrice: 1 }] }),
        payload({ method: "BITCOIN" }),
        payload({ customer: "SECRET-INPUT" }),
        { lines: "SECRET-INPUT" },
      ];
      for (const p of bad) {
        const e = await t.park({ payload: p }).then(
          () => null,
          (err: unknown) => err,
        );
        expect(e).toBeInstanceOf(BadRequestException);
        expect(JSON.stringify((e as BadRequestException).getResponse())).not.toContain("SECRET");
      }
      expect(t.db.rows).toHaveLength(0);
    });
    it("a NUL escape in the payload is a 400, never a driver 500", async () => {
      const t = setup();
      await expect(
        t.park({ payload: payload({ lines: [line({ name: "a\u0000b" })] }) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("idempotent replay and the cap", () => {
    it("the same id, tenant and register returns the stored row once, with replayed: true", async () => {
      const t = setup();
      const first = await t.park();
      const again = await t.park({}, OP, new Date(NOW.getTime() + 60_000));
      expect(t.db.rows).toHaveLength(1);
      expect(again).toMatchObject({ id: first.id, label: first.label, replayed: true });
      expect(again.createdAt).toBe(first.createdAt);
      expect(again.expiresAt).toBe(first.expiresAt);
    });
    it("a CLOSED row is never a replay: park -> resume -> park the same id is 409 PARK_ID_CONFLICT, not the resumed cart", async () => {
      const t = setup();
      await t.park();
      await t.service.resume(id(1), A1, OP, NOW);
      const e = await t.park({}, OP, new Date(NOW.getTime() + 60_000)).then(
        () => null,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).getResponse()).toMatchObject({ code: "PARK_ID_CONFLICT" });
      expect(t.db.rows).toHaveLength(1);
      expect(t.db.rows[0].resumedAt).not.toBeNull();
    });
    it("an EXPIRED row is never a replay either: the same id after 24 h is 409 PARK_ID_CONFLICT", async () => {
      const t = setup();
      await t.park();
      const e = await t.park({}, OP, new Date(NOW.getTime() + 25 * 3_600_000)).then(
        () => null,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).getResponse()).toMatchObject({ code: "PARK_ID_CONFLICT" });
      expect(t.db.rows).toHaveLength(1);
    });
    it("the id-conflict 409 carries the code (another tenant's id, a different register)", async () => {
      const t = setup();
      await t.park();
      t.setTenant(OTHER_TENANT);
      const e = await t.park().then(
        () => null,
        (err: unknown) => err,
      );
      expect((e as ConflictException).getResponse()).toMatchObject({ code: "PARK_ID_CONFLICT" });
    });
    it("another tenant's id (or a different register) => 409 that does not say which", async () => {
      const t = setup();
      await t.park();
      t.setTenant(OTHER_TENANT);
      const e1 = await t.park().then(
        () => null,
        (err: unknown) => err,
      );
      expect(e1).toBeInstanceOf(ConflictException);
      expect(JSON.stringify((e1 as ConflictException).getResponse())).not.toMatch(
        /tenant|register/i,
      );
      expect(t.db.rows).toHaveLength(1);
      t.setTenant(TENANT);
      const e2 = await t.park({ registerKey: "front-2" }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(e2).toBeInstanceOf(ConflictException);
      expect((e1 as ConflictException).getResponse()).toEqual(
        (e2 as ConflictException).getResponse(),
      );
    });
    it("the 10th open cart is accepted, the 11th is 409 PARK_LIMIT", async () => {
      const t = setup();
      for (let i = 1; i <= COUNTER_PARK_MAX_PER_REGISTER; i++) await t.park({ id: id(i) });
      expect(t.db.rows).toHaveLength(10);
      const e = await t.park({ id: id(11) }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).getResponse()).toMatchObject({
        code: API_ERROR_CODES.PARK_LIMIT,
        scope: "register",
      });
      expect(t.db.rows).toHaveLength(10);
    });
    it("a replay at the cap is still the stored row (it does not count against the cap)", async () => {
      const t = setup();
      for (let i = 1; i <= 10; i++) await t.park({ id: id(i) });
      await expect(t.park({ id: id(4) })).resolves.toMatchObject({ id: id(4), replayed: true });
    });
    it("the cap is per register, per tenant, and counts only OPEN rows", async () => {
      const t = setup();
      for (let i = 1; i <= 10; i++) await t.park({ id: id(i) });
      await expect(t.park({ id: id(20), registerKey: "front-2" })).resolves.toBeDefined();
      t.setTenant(OTHER_TENANT);
      await expect(t.park({ id: id(21) })).resolves.toBeDefined();
      t.setTenant(TENANT);
      t.db.rows[0].resumedAt = NOW; // resumed: no longer open
      await expect(t.park({ id: id(22) })).resolves.toBeDefined();
      t.db.rows[1].expiresAt = new Date(NOW.getTime() - 1); // expired: no longer open
      await expect(t.park({ id: id(23) })).resolves.toBeDefined();
    });
    it("a tenant-wide cap bounds the class however many registers there are: the 51st open cart is 409 PARK_LIMIT (scope tenant)", async () => {
      const t = setup();
      // 5 registers x 10 = 50 open carts, each register exactly at its own cap
      let n = 1;
      for (let r = 1; r <= 5; r++) {
        for (let i = 0; i < COUNTER_PARK_MAX_PER_REGISTER; i++) {
          await t.park({ id: id(n++), registerKey: `till-${r}` });
        }
      }
      expect(t.db.rows).toHaveLength(COUNTER_PARK_MAX_PER_TENANT);
      // a brand-new register (its own count is 0) is still refused: the tenant is full
      const e = await t.park({ id: id(900), registerKey: "till-6" }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).getResponse()).toMatchObject({
        code: API_ERROR_CODES.PARK_LIMIT,
        scope: "tenant",
      });
      expect(t.db.rows).toHaveLength(COUNTER_PARK_MAX_PER_TENANT);
      // a replay of an existing cart is still its stored row, and another tenant has its own 50
      await expect(t.park({ id: id(3), registerKey: "till-1" })).resolves.toMatchObject({
        replayed: true,
      });
      t.setTenant(OTHER_TENANT);
      await expect(t.park({ id: id(901), registerKey: "till-6" })).resolves.toBeDefined();
      t.setTenant(TENANT);
      // a resumed cart frees a slot for any register
      t.db.rows[0].resumedAt = NOW;
      await expect(t.park({ id: id(902), registerKey: "till-6" })).resolves.toBeDefined();
    });
    it("takes the transaction-scoped advisory lock FIRST, keyed by (counter-park, tenant), then replay, cap, insert", async () => {
      const t = setup();
      await t.park({ registerKey: "front-2" });
      const sqls = t.db.statements.map((s) => s.sql);
      expect(sqls[0]).toContain("pg_advisory_xact_lock(hashtext(?), hashtext(?))");
      // ONE lock per tenant, whatever the register: it serialises the per-register and the tenant-wide count together
      expect(t.db.statements[0].values).toEqual(["counter-park", TENANT]);
      expect(sqls[1]).toContain('WHERE "id" = ? AND "tenantId" = ?');
      expect(sqls[2]).toContain("count(*)");
      expect(sqls[3]).toContain('ON CONFLICT ("id") DO NOTHING');
      expect(t.prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    });
    it("its advisory-lock family is registered in db-locks LOCK_FAMILIES (one list of every family)", async () => {
      const t = setup();
      await t.park({ registerKey: "front-2" });
      const family = t.db.statements[0].values[0] as string;
      expect(LOCK_FAMILIES as readonly string[]).toContain(family);
    });
    it("runs the whole transaction again on a write conflict (one shared predicate), not on a business error", async () => {
      const t = setup();
      const real = t.prisma.tenantTransaction.getMockImplementation()!;
      t.prisma.tenantTransaction.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("deadlock"), { code: "40P01" })),
      );
      jest.useFakeTimers({ doNotFake: ["nextTick"] });
      try {
        const p = t.park();
        await jest.advanceTimersByTimeAsync(150);
        await expect(p).resolves.toMatchObject({ id: id(1) });
      } finally {
        jest.useRealTimers();
      }
      expect(t.prisma.tenantTransaction).toHaveBeenCalledTimes(2);
      t.prisma.tenantTransaction.mockImplementation(real);
    });
  });

  it("every statement carries an explicit tenant clause bound to the caller's tenant", async () => {
    const t = setup();
    await t.park();
    await t.service.list({}, NOW);
    await t.service.resume(id(1), A1, OP, NOW);
    for (const s of t.db.statements.filter((x) => !x.sql.startsWith("SELECT pg_advisory"))) {
      expect(s.sql).toContain('"tenantId"');
      expect(s.values).toContain(TENANT);
    }
  });
});

describe("CounterParkService.list", () => {
  it("returns only OPEN rows of this tenant and register, newest first, without the payload", async () => {
    const t = setup();
    for (let i = 1; i <= 3; i++) {
      await t.park(
        {
          id: id(i),
          payload: payload({ customer: i === 2 ? { id: "c", businessName: "Acme Foods" } : null }),
        },
        OP,
        new Date(NOW.getTime() + i * 1000),
      );
    }
    await t.park({ id: id(8), registerKey: "front-2" }); // another register
    t.setTenant(OTHER_TENANT);
    await t.park({ id: id(9) }); // another tenant
    t.setTenant(TENANT);
    t.db.rows.find((r) => r.id === id(1))!.resumedAt = NOW; // resumed
    await t.park({ id: id(4) }, OP, new Date(NOW.getTime() - 48 * 3_600_000)); // already expired at NOW

    const res = await t.service.list({ page: 1, pageSize: 20 }, NOW);
    expect(res.data.map((r) => r.id)).toEqual([id(3), id(2)]);
    expect(res.total).toBe(2);
    expect(res.data[1]).toMatchObject({ lineCount: 1, customerName: "Acme Foods" });
    expect(res.data[0]).not.toHaveProperty("customerName");
    for (const r of res.data) expect(r).not.toHaveProperty("payload");
    expect(JSON.stringify(res)).not.toContain("Acme Widget");
  });

  it("row 330e: each row carries the pricing inputs of its lines (and nothing else of them), so the screen can total it", async () => {
    const t = setup();
    await t.park({
      id: id(1),
      payload: payload({
        lines: [
          line({
            unitPrice: 2.5,
            qty: 2,
            boxes: 1,
            pieces: 3,
            unitsPerBox: 12,
            note: "keep cold",
            tierPrices: { pricePerUnit: 2 },
          }),
          line({ tempId: "t-2", unitPrice: 4, qty: 1 }),
        ],
      }),
    });
    const res = await t.service.list({ page: 1, pageSize: 20 }, NOW);
    expect(res.data[0].priceLines).toEqual([
      { unitPrice: 2.5, qty: 2, boxes: 1, pieces: 3, unitsPerBox: 12 },
      { unitPrice: 4, qty: 1 },
    ]);
    expect(JSON.stringify(res)).not.toContain("keep cold");
    expect(JSON.stringify(res)).not.toContain("Acme Widget");
  });

  it("row 330e: priceLinesOf drops a line with no finite price or qty and reads a non-array as none", () => {
    expect(
      priceLinesOf({ lines: [{ unitPrice: "x", qty: 1 }, { unitPrice: 1 }, null, 7] }),
    ).toEqual([]);
    expect(priceLinesOf({ lines: "nope" })).toEqual([]);
    expect(priceLinesOf(null)).toEqual([]);
    expect(priceLinesOf({ lines: [{ unitPrice: "2.5", qty: "3", boxes: null }] })).toEqual([
      { unitPrice: 2.5, qty: 3 },
    ]);
  });

  it("pages (skip/take) and reports the open total; a missing or invalid register is the default", async () => {
    const t = setup();
    for (let i = 1; i <= 5; i++)
      await t.park({ id: id(i) }, OP, new Date(NOW.getTime() + i * 1000));
    const p1 = await t.service.list({ page: 1, pageSize: 2 }, NOW);
    const p3 = await t.service.list({ page: 3, pageSize: 2 }, NOW);
    expect(p1.data.map((r) => r.id)).toEqual([id(5), id(4)]);
    expect(p3.data.map((r) => r.id)).toEqual([id(1)]);
    expect(p1).toMatchObject({ total: 5, page: 1, pageSize: 2 });
    for (const register of [undefined, "", "bad key!", "x".repeat(65)]) {
      const r = await t.service.list({ register, page: 1, pageSize: 20 }, NOW);
      expect(r.total).toBe(5);
    }
    expect((await t.service.list({}, NOW)).pageSize).toBe(20);
  });

  it("never selects the payload column", async () => {
    const t = setup();
    await t.service.list({}, NOW);
    const sql = t.db.statements.find((s) => s.sql.includes("LIMIT"))!.sql;
    expect(sql).not.toMatch(/SELECT[^F]*"payload"\s*,/);
    expect(sql).not.toMatch(/"payload" AS/);
  });
});

describe("CounterParkService.resume", () => {
  const parked = async (t: ReturnType<typeof setup>) => {
    await t.park({ payload: payload({ lines: [line(), line({ tempId: "t-2" })] }) });
  };

  it("is ONE compare-and-set UPDATE with the actor, tenant, id and clock bound; returns the sanitized payload", async () => {
    const t = setup();
    await parked(t);
    const res = await t.service.resume(id(1), A1, OP2, NOW);
    const upd = t.db.statements.find((s) => s.sql.startsWith("UPDATE"))!;
    expect(upd.sql).toContain(
      `SET "resumedAt" = ?, "resumedById" = ?, "payload" = jsonb_set("payload", '{_resume}'`,
    );
    expect(upd.sql).toContain("jsonb_build_object('attemptId', ?::text)");
    // a non-object stored payload matches no row (0 rows -> retry read -> 404), it never reaches jsonb_set
    expect(upd.sql).toContain(`AND jsonb_typeof("payload") = 'object'`);
    expect(upd.sql).toContain(
      'WHERE "id" = ? AND "tenantId" = ? AND "resumedAt" IS NULL AND "expiresAt" > ?',
    );
    expect(upd.sql).toContain('RETURNING "id", "label", "createdAt", "payload"');
    expect(upd.values).toEqual([NOW, "op-2", A1, id(1), TENANT, NOW]);
    expect(res.id).toBe(id(1));
    expect(res.payload.lines).toHaveLength(2);
    expect(res.payload).not.toHaveProperty("_resume");
    expect(res.createdAt).toBe(NOW.toISOString());
    expect(t.db.rows).toHaveLength(1); // never deleted
    expect(t.db.rows[0]).toMatchObject({ resumedById: "op-2" });
    expect(t.db.statements.some((s) => /DELETE/i.test(s.sql))).toBe(false);
    expect(t.deleteMany).not.toHaveBeenCalled();
  });

  it("a second caller (another actor, another attempt) gets 404 PARK_TAKEN", async () => {
    const t = setup();
    await parked(t);
    await t.service.resume(id(1), A1, OP, NOW);
    const e = await t.service.resume(id(1), B1, OP2, NOW).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(NotFoundException);
    expect((e as NotFoundException).getResponse()).toMatchObject({
      code: API_ERROR_CODES.PARK_TAKEN,
    });
  });

  it("the SAME LOGIN on a second till (a different attempt id) within 5 minutes is 404 PARK_TAKEN, never the payload", async () => {
    const t = setup();
    await parked(t);
    await t.service.resume(id(1), A1, OP, NOW); // till A
    await expect(
      t.service.resume(id(1), B1, OP, new Date(NOW.getTime() + 1000)), // till B, same login
    ).rejects.toMatchObject({ response: { code: API_ERROR_CODES.PARK_TAKEN } });
  });

  it("a retry with the SAME attempt id within 5 minutes returns the payload again (no _resume in it); after that it does not", async () => {
    const t = setup();
    await parked(t);
    const first = await t.service.resume(id(1), A1, OP, NOW);
    const retry = await t.service.resume(
      id(1),
      A1,
      OP,
      new Date(NOW.getTime() + COUNTER_PARK_RETRY_WINDOW_MS - 1000),
    );
    expect(retry.payload).toEqual(first.payload);
    expect(retry.payload.lines).toHaveLength(2);
    expect(JSON.stringify(retry)).not.toContain("_resume");
    expect(JSON.stringify(retry)).not.toContain(A1);
    await expect(
      t.service.resume(
        id(1),
        A1,
        OP,
        new Date(NOW.getTime() + COUNTER_PARK_RETRY_WINDOW_MS + 1000),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the retry predicate is the attempt id: another actor with the same attempt id is not special-cased, and a wrong attempt never reads", async () => {
    const t = setup();
    await parked(t);
    await t.service.resume(id(1), A1, OP, NOW);
    const retrySql = () => t.db.statements.filter((s) => s.sql.startsWith("SELECT")).pop()!;
    await expect(t.service.resume(id(1), B1, OP, NOW)).rejects.toBeInstanceOf(NotFoundException);
    expect(retrySql().sql).toContain(`"payload"->'_resume'->>'attemptId' = ?`);
    expect(retrySql().sql).not.toContain("resumedById");
  });

  it("an expired, discarded, unknown, malformed or other-tenant id is 404 PARK_TAKEN", async () => {
    const t = setup();
    await parked(t);
    const expired = new Date(NOW.getTime() + 25 * 3_600_000);
    await expect(t.service.resume(id(1), A1, OP, expired)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PARK_TAKEN },
    });
    await expect(t.service.resume(id(99), A1, OP, NOW)).rejects.toBeInstanceOf(NotFoundException);
    const before = t.db.statements.length;
    await expect(t.service.resume("not-a-uuid", A1, OP, NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(t.db.statements).toHaveLength(before); // no query for a malformed id
    t.setTenant(OTHER_TENANT);
    await expect(t.service.resume(id(1), A1, OP, NOW)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PARK_TAKEN },
    });
    expect(t.db.rows[0].resumedAt).toBeNull(); // the other tenant's attempt changed nothing
  });

  it("another tenant's resumed row is not retryable by a same-numbered actor in this tenant", async () => {
    const t = setup();
    await parked(t);
    await t.service.resume(id(1), A1, OP, NOW);
    t.setTenant(OTHER_TENANT);
    await expect(t.service.resume(id(1), A1, OP, NOW)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a stored row that no longer sanitizes is 404 PARK_TAKEN, never a 500", async () => {
    const t = setup();
    await parked(t);
    t.db.rows[0].payload = { lines: [{ nope: true }], method: "CASH" };
    await expect(t.service.resume(id(1), A1, OP, NOW)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PARK_TAKEN },
    });
  });
});

describe("CounterParkService.discard", () => {
  it("deletes by { id, tenantId, resumedAt: null } through the tenant client", async () => {
    const t = setup();
    t.deleteMany.mockResolvedValue({ count: 1 });
    await expect(t.service.discard(id(1))).resolves.toBeUndefined();
    expect(t.deleteMany).toHaveBeenCalledWith({
      where: { id: id(1), tenantId: TENANT, resumedAt: null },
    });
  });
  it("count 0 (taken, discarded, expired-swept, unknown, other tenant) => 404 PARK_TAKEN", async () => {
    const t = setup();
    const e = await t.service.discard(id(1)).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(NotFoundException);
    expect((e as NotFoundException).getResponse()).toMatchObject({
      code: API_ERROR_CODES.PARK_TAKEN,
    });
  });
  it("a malformed id never reaches the database", async () => {
    const t = setup();
    await expect(t.service.discard("nope")).rejects.toBeInstanceOf(NotFoundException);
    expect(t.deleteMany).not.toHaveBeenCalled();
  });
});

describe("the COUNTER_SALES_DISABLED gate and the tenant, on every route", () => {
  const calls: Array<[string, (t: ReturnType<typeof setup>) => Promise<unknown>]> = [
    ["park", (t) => t.park()],
    ["list", (t) => t.service.list({}, NOW)],
    ["resume", (t) => t.service.resume(id(1), A1, OP, NOW)],
    ["discard", (t) => t.service.discard(id(1))],
  ];

  it.each(calls)(
    "%s is 403 COUNTER_SALES_DISABLED when counter sales are off, before any query",
    async (_n, call) => {
      const t = setup({ counter: "off" });
      const e = await call(t).then(
        () => null,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(ForbiddenException);
      expect((e as ForbiddenException).getResponse()).toMatchObject({
        code: API_ERROR_CODES.COUNTER_SALES_DISABLED,
      });
      expect(t.db.statements).toHaveLength(0);
      expect(t.deleteMany).not.toHaveBeenCalled();
    },
  );

  it.each(calls)(
    "%s refuses a session without a tenant (forTenant() would be unscoped)",
    async (_n, call) => {
      const t = setup();
      t.setTenant(null);
      await expect(call(t)).rejects.toBeInstanceOf(ForbiddenException);
      expect(t.db.statements).toHaveLength(0);
      expect(t.deleteMany).not.toHaveBeenCalled();
    },
  );

  it("uses the SAME gate function as POST /orders/counter-sale", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    const ring = fs.readFileSync(`${__dirname}/counter-sale.service.ts`, "utf8");
    const park = fs.readFileSync(`${__dirname}/counter-park.service.ts`, "utf8");
    expect(ring).toContain("assertCounterSalesEnabled(");
    expect(park).toContain("assertCounterSalesEnabled(");
  });
});
