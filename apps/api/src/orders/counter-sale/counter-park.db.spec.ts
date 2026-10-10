/**
 * SA-748 — real-Postgres pins for PARK / RESUME (counter-park.service.ts + counter-park.sweep.ts): the resume
 * compare-and-set under N=10 parallel callers, the same-actor retry, the advisory-lock cap under 15 parallel parks, the
 * ON CONFLICT replay, expiry, the sweep, and tenant isolation.
 *
 * NOT RUN by the authoring lane (no Postgres here): the DB lane runs it (`npm run local:test:db`, test tenants only,
 * collected only by jest.db.config.js).
 */
jest.mock("../../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { COUNTER_PARK_MAX_PER_REGISTER, COUNTER_PARK_MAX_PER_TENANT } from "@routeflow/pricing";
import { deriveFulfilmentCapability } from "../../billing/fulfilment-capability";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { CounterParkService } from "./counter-park.service";
import { CounterParkSweepService } from "./counter-park.sweep";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const H = 3_600_000;
const line = (n: number) => ({
  tempId: `t-${n}`,
  productId: `prod-${n}`,
  name: "Acme Widget",
  unitPrice: 2.5,
  qty: 2,
});
const payload = (lines = 1) => ({
  lines: Array.from({ length: lines }, (_, i) => line(i)),
  customer: null,
  method: "CASH",
  tendered: "",
  reference: "",
});

describeDb("SA-748 — parked counter sales on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: CounterParkService;
  let sweep: CounterParkSweepService;
  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-cs-park-a-${run}`, "counter-park.db.spec.ts");
  const slugB = assertTestTenant(`qa-cs-park-b-${run}`, "counter-park.db.spec.ts");
  const tenants: Record<"A" | "B", string> = { A: "", B: "" };
  /** ten operators of tenant A (distinct actors for the resume race) and one of tenant B */
  const actorsA: Array<{ sub: string }> = [];
  let actorB: { sub: string };
  const userIds: string[] = [];

  const asA = <T>(fn: () => Promise<T>) => tenantCtx.run(tenants.A, fn);
  const asB = <T>(fn: () => Promise<T>) => tenantCtx.run(tenants.B, fn);
  const park = (
    as: "A" | "B",
    over: { id?: string; registerKey?: string; lines?: number } = {},
    actor: { sub: string } = as === "A" ? actorsA[0] : actorB,
    now?: Date,
  ) =>
    tenantCtx.run(tenants[as], () =>
      service.park(
        {
          id: over.id ?? randomUUID(),
          registerKey: over.registerKey,
          payload: payload(over.lines ?? 1),
        } as never,
        actor as never,
        now,
      ),
    );
  /** A deterministic uuid v4 per resume attempt (the client mints a fresh one per tap). */
  const attempt = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const outcome = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  const codeOf = (e: unknown) =>
    ((e as { getResponse?: () => { code?: string } }).getResponse?.() ?? {}).code;

  async function makeUser(tenant: "A" | "B", n: number): Promise<{ sub: string }> {
    const user = await raw.user.create({
      data: {
        email: `op-${tenant}-${n}-${run}@example.test`,
        username: `op-${tenant}-${n}-${run}`,
        role: "OPERATOR",
        tenantId: tenants[tenant],
      },
    });
    userIds.push(user.id);
    return { sub: user.id };
  }

  const rowsOf = (tenant: "A" | "B", registerKey = "main") =>
    raw.counterParkedCart.findMany({ where: { tenantId: tenants[tenant], registerKey } });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const capability = {
      get: async () => ({
        ...deriveFulfilmentCapability({ mode: "unset", counterSales: "unset", fleet: false }),
        counter: "always" as const,
      }),
    };
    service = new CounterParkService(prisma, capability as never);
    sweep = new CounterParkSweepService(prisma);
    tenants.A = (await raw.tenant.create({ data: { slug: slugA, name: `Park A ${slugA}` } })).id;
    tenants.B = (await raw.tenant.create({ data: { slug: slugB, name: `Park B ${slugB}` } })).id;
    await raw.tenantConfig.create({ data: { tenantId: tenants.A, timezone: "America/New_York" } });
    await raw.tenantConfig.create({ data: { tenantId: tenants.B, timezone: "America/New_York" } });
    for (let i = 0; i < 10; i++) actorsA.push(await makeUser("A", i));
    actorB = await makeUser("B", 0);
  }, 120_000);

  // The tenant-wide cap counts every register, so each scenario starts from an empty table for both tenants.
  beforeEach(async () => {
    await raw.counterParkedCart.deleteMany({
      where: { tenantId: { in: Object.values(tenants).filter(Boolean) } },
    });
  });

  afterAll(async () => {
    await raw?.counterParkedCart.deleteMany({
      where: { tenantId: { in: Object.values(tenants).filter(Boolean) } },
    });
    await raw?.user.deleteMany({ where: { id: { in: userIds } } });
    await raw?.tenantConfig.deleteMany({ where: { tenantId: { in: Object.values(tenants) } } });
    await raw?.tenant.deleteMany({ where: { id: { in: Object.values(tenants) } } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("park stores only the rebuilt payload, version 1, the actor, a 24 h expiry, and lists without the payload", async () => {
    const id = randomUUID();
    const res = await tenantCtx.run(tenants.A, () =>
      service.park(
        {
          id,
          registerKey: "park-store",
          label: "Aisle 3",
          payload: {
            ...payload(2),
            customer: { id: "c-1", businessName: "Acme Foods", email: "a@acme.test" },
            sneaky: true,
          },
        } as never,
        actorsA[3] as never,
      ),
    );
    expect(res).toMatchObject({ id, label: "Aisle 3", registerKey: "park-store", lineCount: 2 });
    const row = await raw.counterParkedCart.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      tenantId: tenants.A,
      createdById: actorsA[3].sub,
      payloadVersion: 1,
      resumedAt: null,
    });
    expect(JSON.stringify(row.payload)).not.toContain("a@acme.test");
    expect(JSON.stringify(row.payload)).not.toContain("sneaky");
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(24 * H);
    const list = await asA(() => service.list({ register: "park-store" }));
    expect(list.data.map((r) => r.id)).toEqual([id]);
    expect(list.data[0]).toMatchObject({ lineCount: 2, customerName: "Acme Foods" });
    expect(list.data[0]).not.toHaveProperty("payload");
    expect(list.total).toBe(1);
  });

  it("N=10 parallel resumes of one cart: exactly ONE wins, the other nine are 404 PARK_TAKEN", async () => {
    const { id } = await park("A", { registerKey: "race" });
    const results = await Promise.all(
      actorsA.map((a, i) => outcome(asA(() => service.resume(id, attempt(i), a as never)))),
    );
    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(9);
    for (const l of losses) {
      expect(l.ok === false && l.error).toBeInstanceOf(NotFoundException);
      expect(l.ok === false && codeOf(l.error)).toBe(API_ERROR_CODES.PARK_TAKEN);
    }
    const row = await raw.counterParkedCart.findUniqueOrThrow({ where: { id } });
    expect(row.resumedAt).not.toBeNull();
    expect(actorsA.map((a) => a.sub)).toContain(row.resumedById);
    // resume never deletes
    expect(await raw.counterParkedCart.count({ where: { id } })).toBe(1);
  });

  it("a retry with the SAME attempt id within 5 minutes re-reads the cart (no _resume in the body); a second till on the same login, another actor, and a late retry get 404 PARK_TAKEN", async () => {
    const { id } = await park("A", { registerKey: "retry", lines: 3 });
    const first = await asA(() => service.resume(id, attempt(1), actorsA[0] as never));
    const again = await asA(() => service.resume(id, attempt(1), actorsA[0] as never));
    expect(again.payload).toEqual(first.payload);
    expect(again.payload.lines).toHaveLength(3);
    expect(JSON.stringify([first, again])).not.toContain("_resume");
    // till B on the SAME login, a different attempt id: refused (the double-sale hole)
    await expect(
      asA(() => service.resume(id, attempt(2), actorsA[0] as never)),
    ).rejects.toMatchObject({ response: { code: API_ERROR_CODES.PARK_TAKEN } });
    await expect(
      asA(() => service.resume(id, attempt(2), actorsA[1] as never)),
    ).rejects.toMatchObject({ response: { code: API_ERROR_CODES.PARK_TAKEN } });
    await expect(
      asA(() =>
        service.resume(id, attempt(1), actorsA[0] as never, new Date(Date.now() + 6 * 60_000)),
      ),
    ).rejects.toMatchObject({ response: { code: API_ERROR_CODES.PARK_TAKEN } });
    // the server-reserved key is stored in the row's own JSON and nowhere in a response
    const row = await raw.counterParkedCart.findUniqueOrThrow({ where: { id } });
    expect((row.payload as { _resume?: { attemptId?: string } })._resume?.attemptId).toBe(
      attempt(1),
    );
  });

  it("two concurrent resumes with DIFFERENT attempt ids: one 200, one 404 PARK_TAKEN", async () => {
    const { id } = await park("A", { registerKey: "race-attempts" });
    const [x, y] = await Promise.all([
      outcome(asA(() => service.resume(id, attempt(3), actorsA[0] as never))),
      outcome(asA(() => service.resume(id, attempt(4), actorsA[0] as never))),
    ]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    const loser = x.ok ? y : x;
    expect(loser.ok === false && codeOf(loser.error)).toBe(API_ERROR_CODES.PARK_TAKEN);
  });

  it("park -> resume -> park the same id again is 409 PARK_ID_CONFLICT, never replayed: true", async () => {
    const { id } = await park("A", { registerKey: "replay-closed" });
    await asA(() => service.resume(id, attempt(5), actorsA[0] as never));
    const e = await outcome(park("A", { id, registerKey: "replay-closed" }));
    expect(e.ok).toBe(false);
    expect(e.ok === false && (e.error as { status?: number }).status).toBe(409);
    expect(e.ok === false && codeOf(e.error)).toBe(API_ERROR_CODES.PARK_ID_CONFLICT);
    // an expired row is closed too
    const old = await park("A", { registerKey: "replay-closed" });
    const e2 = await outcome(
      park(
        "A",
        { id: old.id, registerKey: "replay-closed" },
        undefined,
        new Date(Date.now() + 25 * H),
      ),
    );
    expect(e2.ok === false && codeOf(e2.error)).toBe(API_ERROR_CODES.PARK_ID_CONFLICT);
  });

  it("a park whose payload names the server-reserved _resume key is a 400 and stores nothing", async () => {
    const id = randomUUID();
    const e = await outcome(
      asA(() =>
        service.park(
          { id, payload: { ...payload(1), _resume: { attemptId: attempt(6) } } } as never,
          actorsA[0] as never,
        ),
      ),
    );
    expect(e.ok === false && (e.error as { status?: number }).status).toBe(400);
    expect(await raw.counterParkedCart.count({ where: { id } })).toBe(0);
  });

  it("15 parallel parks on one register: exactly 10 rows, the other 5 are 409 PARK_LIMIT (the advisory lock holds)", async () => {
    const results = await Promise.all(
      Array.from({ length: 15 }, () => outcome(park("A", { registerKey: "cap" }))),
    );
    const failed = results.filter((r) => !r.ok);
    expect(results.filter((r) => r.ok)).toHaveLength(COUNTER_PARK_MAX_PER_REGISTER);
    expect(failed).toHaveLength(5);
    for (const f of failed)
      expect(f.ok === false && codeOf(f.error)).toBe(API_ERROR_CODES.PARK_LIMIT);
    expect(await rowsOf("A", "cap")).toHaveLength(10);
    // the 11th is still refused afterwards, a replay is not, and discarding one frees a place
    await expect(park("A", { registerKey: "cap" })).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PARK_LIMIT },
    });
    const [any] = await rowsOf("A", "cap");
    await expect(park("A", { id: any.id, registerKey: "cap" })).resolves.toMatchObject({
      id: any.id,
      replayed: true,
    });
    await asA(() => service.discard(any.id));
    await expect(park("A", { registerKey: "cap" })).resolves.toBeDefined();
    // another register and another tenant are untouched by the cap
    await expect(park("A", { registerKey: "cap-2" })).resolves.toBeDefined();
    await expect(park("B", { registerKey: "cap" })).resolves.toBeDefined();
  });

  it("the tenant-wide cap holds under one lock: 60 parallel parks over 6 registers leave exactly 50 rows, the other 10 are 409 PARK_LIMIT (scope tenant)", async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => outcome(park("A", { registerKey: `till-${i % 6}` }))),
    );
    const won = results.filter((r) => r.ok);
    const lost = results.filter((r) => !r.ok);
    expect(won).toHaveLength(COUNTER_PARK_MAX_PER_TENANT);
    expect(lost).toHaveLength(60 - COUNTER_PARK_MAX_PER_TENANT);
    for (const r of lost) {
      expect(codeOf((r as { error: unknown }).error)).toBe(API_ERROR_CODES.PARK_LIMIT);
      expect(
        ((r as { error: { getResponse: () => { scope?: string } } }).error.getResponse() ?? {})
          .scope,
      ).toBe("tenant");
    }
    expect(await raw.counterParkedCart.count({ where: { tenantId: tenants.A } })).toBe(
      COUNTER_PARK_MAX_PER_TENANT,
    );
    // a fresh register is refused too while the tenant is full; another tenant has its own 50; a discard frees a slot
    await expect(park("A", { registerKey: "till-new" })).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PARK_LIMIT, scope: "tenant" },
    });
    await expect(park("B", { registerKey: "till-new" })).resolves.toBeDefined();
    const any = await raw.counterParkedCart.findFirst({ where: { tenantId: tenants.A } });
    await asA(() => service.discard(any!.id));
    await expect(park("A", { registerKey: "till-new" })).resolves.toBeDefined();
  });

  it("ON CONFLICT replay: the same id twice (even in parallel) is one row; another tenant's id is 409 and reveals nothing", async () => {
    const id = randomUUID();
    const both = await Promise.all([
      outcome(park("A", { id, registerKey: "replay" })),
      outcome(park("A", { id, registerKey: "replay" })),
    ]);
    expect(both.every((r) => r.ok)).toBe(true);
    expect(
      both.filter((r) => r.ok && (r.value as { replayed?: boolean }).replayed === true),
    ).toHaveLength(1);
    expect(await raw.counterParkedCart.count({ where: { id } })).toBe(1);
    // tenant B tries to park with tenant A's id
    const e = await outcome(park("B", { id, registerKey: "replay" }));
    expect(e.ok).toBe(false);
    expect(e.ok === false && (e.error as { status?: number }).status).toBe(409);
    expect(
      e.ok === false && JSON.stringify((e.error as { getResponse(): unknown }).getResponse()),
    ).not.toMatch(/tenant/i);
    expect(await raw.counterParkedCart.findUniqueOrThrow({ where: { id } })).toMatchObject({
      tenantId: tenants.A,
    });
    // same tenant, different register: also 409
    await expect(park("A", { id, registerKey: "replay-other" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("expiry: an expired cart is not listed, not counted, and cannot be resumed", async () => {
    const { id } = await park("A", { registerKey: "expiry" });
    const later = new Date(Date.now() + 25 * H);
    expect((await asA(() => service.list({ register: "expiry" }, later))).total).toBe(0);
    await expect(
      asA(() => service.resume(id, attempt(0), actorsA[0] as never, later)),
    ).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PARK_TAKEN },
    });
    expect((await asA(() => service.list({ register: "expiry" }))).total).toBe(1);
    // an expired cart does not count against the cap
    const t0 = new Date(Date.now() - 48 * H);
    for (let i = 0; i < 10; i++) await park("A", { registerKey: "expiry-cap" }, actorsA[0], t0);
    await expect(park("A", { registerKey: "expiry-cap" })).resolves.toBeDefined();
  });

  it("a stored payload that no longer passes the whitelist is a 404 AND leaves the cart open (the resume rolls back)", async () => {
    const stale = randomUUID();
    await raw.counterParkedCart.create({
      data: {
        id: stale,
        tenantId: tenants.A,
        registerKey: "rollback",
        createdById: actorsA[0].sub,
        label: "Stale shape",
        // a shape the whitelist refuses (lines is not a list): as if the rules had tightened after it was parked
        payload: { lines: "not-a-list" },
        payloadVersion: 1,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await expect(
      asA(() => service.resume(stale, attempt(0), actorsA[0] as never)),
    ).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PARK_TAKEN },
    });
    const row = await raw.counterParkedCart.findUnique({ where: { id: stale } });
    expect(row?.resumedAt).toBeNull();
    expect(row?.resumedById).toBeNull();
    // still listed, so the clerk can discard it instead of losing it silently
    const listed = await asA(() => service.list({ register: "rollback", page: 1, pageSize: 20 }));
    expect(listed.data.map((r) => r.id)).toContain(stale);
    await expect(asA(() => service.discard(stale))).resolves.toBeUndefined();
  });

  it("discard: only an unresumed cart of this tenant", async () => {
    const mine = await park("A", { registerKey: "discard" });
    const resumed = await park("A", { registerKey: "discard" });
    await asA(() => service.resume(resumed.id, attempt(0), actorsA[0] as never));
    await expect(asB(() => service.discard(mine.id))).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PARK_TAKEN },
    });
    await expect(asA(() => service.discard(resumed.id))).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PARK_TAKEN },
    });
    await expect(asA(() => service.discard(mine.id))).resolves.toBeUndefined();
    await expect(asA(() => service.discard(mine.id))).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PARK_TAKEN },
    });
    expect(await raw.counterParkedCart.count({ where: { id: resumed.id } })).toBe(1);
  });

  it("tenant isolation: another tenant cannot list, resume or discard this tenant's carts", async () => {
    const { id } = await park("A", { registerKey: "iso" });
    expect((await asB(() => service.list({ register: "iso" }))).total).toBe(0);
    await expect(asB(() => service.resume(id, attempt(0), actorB as never))).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PARK_TAKEN },
    });
    await expect(asB(() => service.discard(id))).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PARK_TAKEN },
    });
    const row = await raw.counterParkedCart.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ tenantId: tenants.A, resumedAt: null, resumedById: null });
    expect((await asA(() => service.list({ register: "iso" }))).total).toBe(1);
  });

  it("the sweep deletes a row resumed more than 24 h ago or expired, across tenants, and nothing else", async () => {
    const now = Date.now();
    const base = { payload: payload(1) as never, payloadVersion: 1, label: "sweep" };
    const mk = (tenant: "A" | "B", over: Record<string, unknown>) =>
      raw.counterParkedCart.create({
        data: {
          id: randomUUID(),
          tenantId: tenants[tenant],
          registerKey: "sweep",
          ...base,
          createdAt: new Date(now - 30 * H),
          expiresAt: new Date(now + 10 * H),
          ...over,
        } as never,
      });
    const keepOpen = await mk("A", {});
    const keepRecentlyResumed = await mk("A", { resumedAt: new Date(now - 2 * H) });
    const delResumedOld = await mk("A", { resumedAt: new Date(now - 25 * H) });
    const delExpired = await mk("A", { expiresAt: new Date(now - H) });
    const delExpiredOtherTenant = await mk("B", { expiresAt: new Date(now - H) });

    const res = await sweep.sweep(new Date(now));
    expect(res.deleted).toBeGreaterThanOrEqual(3);
    const left = await raw.counterParkedCart.findMany({
      where: {
        id: {
          in: [keepOpen, keepRecentlyResumed, delResumedOld, delExpired, delExpiredOtherTenant].map(
            (r) => r.id,
          ),
        },
      },
    });
    expect(left.map((r) => r.id).sort()).toEqual([keepOpen.id, keepRecentlyResumed.id].sort());
    // a second run finds nothing more of ours to do
    await expect(sweep.sweep(new Date(now))).resolves.toBeDefined();
    expect(await raw.counterParkedCart.count({ where: { id: keepOpen.id } })).toBe(1);
  });
});
