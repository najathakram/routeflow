import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { createHash } from "crypto";
import { PaymentKeyStatusController } from "./payment-key-status.controller";
import { PaymentKeyStatusService } from "./payment-key-status.service";

/**
 * SA-824 race ruling 3/4/6: POST /invoices/payments/by-key/:key/resolve, with mocked Prisma. The resolve is
 * `INSERT ... TOMBSTONED ... ON CONFLICT ("tenantId","key") DO NOTHING RETURNING` under `SET LOCAL
 * lock_timeout = '5s'` in its own transaction. Postgres makes it WAIT behind an uncommitted claim of the same
 * key; the fake models that wait as a `pending` claim that commits (COMPLETED) or rolls back (gone) at the
 * moment the insert runs. The real two-connection race is payment-key-resolve.db.spec.ts.
 *
 *  - nothing committed -> the tombstone is inserted -> { state: "tombstoned" }
 *  - a claim that commits while the resolve waits -> { state: "found", <the GET by-key body> }
 *  - a claim that rolls back while the resolve waits -> the tombstone -> { state: "tombstoned" }
 *  - resolve twice -> idempotent { state: "tombstoned" }
 *  - lock timeout (55P03) -> 409 PAYMENT_KEY_IN_FLIGHT, nothing written, no audit row
 *  - another tenant's key: never read, never tombstoned (the insert is scoped to the caller's tenant)
 *  - ONE audit row per resolve: actor, sha256 of the key (never the raw key), outcome, invoice / customer id
 */
const RESOLVED_STATES = ["found", "tombstoned"];
const IN_FLIGHT = "PAYMENT_KEY_IN_FLIGHT";

type State = "CLAIMED" | "COMPLETED" | "TOMBSTONED";
interface Row {
  id: string;
  tenantId: string;
  key: string;
  state: State;
  scope: string | null;
  requestHash: string | null;
  result: Record<string, unknown>;
}

const sqlOf = (strings: TemplateStringsArray | string[]) => Array.from(strings).join("?");
const sha = (k: string) => createHash("sha256").update(k).digest("hex");

function build(tenant: string | null, seed: Row[] = []) {
  const rows: Row[] = seed.map((r) => ({ ...r }));
  /** A claim of another connection, uncommitted while the resolve's insert waits on it. */
  let pending: { row: Row; outcome: "commit" | "rollback" } | null = null;
  let insertError: unknown = null;
  const sql: string[] = [];
  const txOpts: unknown[] = [];
  const audit = { log: jest.fn(async (_dto: Record<string, unknown>) => undefined) };

  const tx = {
    $executeRawUnsafe: jest.fn(async (q: string) => {
      sql.push(q);
      return 0;
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
      sql.push(sqlOf(strings));
      return 0;
    }),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...v: unknown[]) => {
      const q = sqlOf(strings);
      sql.push(q);
      if (!q.includes('INSERT INTO "PaymentIdempotencyKey"')) return [];
      if (insertError) throw insertError;
      // The wait: the other transaction ends now, then the insert sees its outcome.
      if (pending) {
        if (pending.outcome === "commit") rows.push({ ...pending.row, state: "COMPLETED" });
        pending = null;
      }
      const [id, tenantId, key] = v as string[];
      if (rows.some((r) => r.tenantId === tenantId && r.key === key)) return [];
      staged.push({
        id,
        tenantId,
        key,
        state: q.includes("'TOMBSTONED'") ? "TOMBSTONED" : ("?" as State),
        scope: null,
        requestHash: null,
        result: {},
      });
      return [{ id }];
    }),
  };
  let staged: Row[] = [];
  const live = { payments: [{ id: "pay-1", status: "VOIDED", checkStatus: null }] };
  const scoped = {
    paymentIdempotencyKey: {
      findFirst: jest.fn(async (a: { where: { key: string } }) => {
        const r = rows.find((x) => x.tenantId === tenant && x.key === a.where.key);
        return r ? { ...r } : null;
      }),
    },
    invoicePayment: { findMany: jest.fn(async () => live.payments) },
    invoice: { findFirst: jest.fn(async () => ({ status: "PARTIAL", paidAt: null })) },
    advancePayment: { findFirst: jest.fn(async () => ({ balance: 12.5 })) },
  };
  const prisma = {
    getTenantId: () => tenant,
    forTenant: () => scoped,
    tenantTransaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>, opts?: unknown) => {
      txOpts.push(opts);
      staged = [];
      const out = await fn(tx);
      rows.push(...staged);
      return out;
    }),
  };
  const service = new (PaymentKeyStatusService as any)(prisma, audit) as PaymentKeyStatusService;
  const controller = new PaymentKeyStatusController(service);
  const actor = { sub: "user-1", tenantId: tenant, impersonatedBy: "sa-9" } as any;
  return {
    rows,
    sql,
    txOpts,
    audit,
    scoped,
    resolve: (key: string) => (controller as any).resolve(key, actor),
    get: (key: string) => controller.byKey(key),
    holdClaim: (row: Row, outcome: "commit" | "rollback") => (pending = { row, outcome }),
    failInsert: (e: unknown) => (insertError = e),
  };
}

const completed = (over: Partial<Row> = {}): Row => ({
  id: "row-1",
  tenantId: "tA",
  key: "k-1",
  state: "COMPLETED",
  scope: "INVOICE_PAYMENT",
  requestHash: "h1",
  result: {
    id: "inv-1",
    customerId: "cust-1",
    status: "PAID",
    createdPaymentId: "pay-1",
    payments: [{ id: "pay-1", status: "PAID" }],
  },
  ...over,
});

describe("SA-824 POST /invoices/payments/by-key/:key/resolve", () => {
  it("nothing committed under the key: inserts a TOMBSTONED row and answers { state: 'tombstoned' }", async () => {
    const t = build("tA");
    const out = await t.resolve("k-new");
    expect(out).toEqual({ state: "tombstoned" });
    expect(t.rows).toEqual([
      expect.objectContaining({ tenantId: "tA", key: "k-new", state: "TOMBSTONED" }),
    ]);
  });

  it("runs SET LOCAL lock_timeout = '5s' FIRST in its own transaction, then INSERT ... ON CONFLICT DO NOTHING RETURNING", async () => {
    const t = build("tA");
    await t.resolve("k-new");
    expect(t.sql[0]).toMatch(/SET LOCAL lock_timeout = '5s'/);
    const insert = t.sql.find((q) => q.includes('INSERT INTO "PaymentIdempotencyKey"'))!;
    expect(insert).toMatch(/'TOMBSTONED'/);
    expect(insert).toMatch(/ON CONFLICT \("tenantId", "key"\) DO NOTHING/);
    expect(insert).toMatch(/RETURNING "id"/);
    // the Prisma transaction outlives the 5 s lock wait, so a timeout surfaces as 55P03, not P2028
    expect((t.txOpts[0] as { timeout: number }).timeout).toBeGreaterThan(5_000);
  });

  it("an uncommitted claim that COMMITS while the resolve waits: { state: 'found' } with exactly the GET by-key body", async () => {
    const t = build("tA");
    t.holdClaim(completed({ state: "CLAIMED" }), "commit");
    const out: any = await t.resolve("k-1");
    expect(out.state).toBe("found");
    expect(out).toEqual(await t.get("k-1"));
    expect(out.payments[0].status).toBe("VOIDED"); // the CURRENT status, as GET re-reads it
    expect(t.rows.filter((r) => r.key === "k-1").map((r) => r.state)).toEqual(["COMPLETED"]);
  });

  it("an uncommitted claim that ROLLS BACK while the resolve waits: the tombstone lands, { state: 'tombstoned' }", async () => {
    const t = build("tA");
    t.holdClaim(completed({ state: "CLAIMED" }), "rollback");
    expect(await t.resolve("k-1")).toEqual({ state: "tombstoned" });
    expect(t.rows.map((r) => r.state)).toEqual(["TOMBSTONED"]);
  });

  it("resolve twice: idempotent { state: 'tombstoned' }, one row", async () => {
    const t = build("tA");
    expect(await t.resolve("k-2")).toEqual({ state: "tombstoned" });
    expect(await t.resolve("k-2")).toEqual({ state: "tombstoned" });
    expect(t.rows).toHaveLength(1);
  });

  it("a lock timeout (55P03) is 409 PAYMENT_KEY_IN_FLIGHT (retryable): nothing written, no audit row", async () => {
    const t = build("tA");
    t.failInsert(
      Object.assign(new Error("canceling statement due to lock timeout"), {
        code: "P2010",
        meta: { code: "55P03" },
      }),
    );
    const err: any = await t.resolve("k-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe(IN_FLIGHT);
    expect(JSON.stringify(err.getResponse())).not.toMatch(/lock timeout/);
    expect(t.rows).toHaveLength(0);
    expect(t.audit.log).not.toHaveBeenCalled();
  });

  it("a Prisma transaction timeout (P2028) is also 409 PAYMENT_KEY_IN_FLIGHT", async () => {
    const t = build("tA");
    t.failInsert(Object.assign(new Error("Transaction already closed"), { code: "P2028" }));
    const err: any = await t.resolve("k-1").catch((e: unknown) => e);
    expect(err.getResponse().code).toBe(IN_FLIGHT);
  });

  it("any other database error is rethrown as is (never reported as in flight or resolved)", async () => {
    const t = build("tA");
    const boom = new Error("connection reset");
    t.failInsert(boom);
    await expect(t.resolve("k-1")).rejects.toBe(boom);
    expect(t.audit.log).not.toHaveBeenCalled();
  });

  it("a committed CLAIMED row (never settled) is 409 PAYMENT_KEY_IN_FLIGHT, never 'found' with an empty result", async () => {
    const t = build("tA", [completed({ state: "CLAIMED", result: {} })]);
    const err: any = await t.resolve("k-1").catch((e: unknown) => e);
    expect(err.getResponse().code).toBe(IN_FLIGHT);
  });

  it("another tenant's key is never read and never tombstoned: the caller's tenant gets its OWN tombstone", async () => {
    const t = build("tB", [completed()]); // k-1 belongs to tenant tA
    expect(await t.resolve("k-1")).toEqual({ state: "tombstoned" });
    const a = t.rows.find((r) => r.tenantId === "tA")!;
    expect(a.state).toBe("COMPLETED");
    expect(t.rows.find((r) => r.tenantId === "tB")?.state).toBe("TOMBSTONED");
  });

  it("ONE audit row per resolve: actor, sha256 of the key (never the raw key), outcome, the invoice and customer ids", async () => {
    const t = build("tA", [completed()]);
    await t.resolve("k-1");
    await t.resolve("k-new");
    expect(t.audit.log).toHaveBeenCalledTimes(2);
    const [found, tomb] = t.audit.log.mock.calls.map((c) => c[0] as Record<string, any>);
    expect(found).toMatchObject({
      tenantId: "tA",
      userId: "user-1",
      impersonatedBy: "sa-9",
      entityId: sha("k-1"),
      meta: expect.objectContaining({
        keyHash: sha("k-1"),
        outcome: "found",
        invoiceId: "inv-1",
        customerId: "cust-1",
      }),
    });
    expect(tomb.meta).toMatchObject({ keyHash: sha("k-new"), outcome: "tombstoned" });
    for (const dto of [found, tomb]) {
      expect(RESOLVED_STATES).toContain(dto.meta.outcome);
      expect(JSON.stringify(dto)).not.toMatch(/"k-1"|"k-new"|k-new\b/);
    }
  });

  it("a malformed key is a 400 (the shared normaliser), before any transaction", async () => {
    const t = build("tA");
    for (const bad of ["a b", "k".repeat(129), "  "]) {
      await expect(t.resolve(bad)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(t.sql).toHaveLength(0);
  });

  it("no tenant on the session: refused, never an unscoped write", async () => {
    const t = build(null);
    await expect(t.resolve("k-1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.sql).toHaveLength(0);
  });
});
