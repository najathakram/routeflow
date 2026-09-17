/**
 * B467 — real-Postgres proof of InlineReturnsService.capture()'s two concurrency
 * invariants that a jest-mocked Prisma client cannot prove: a mocked transaction/lock
 * just resolves in call order, so nothing in the mocked unit suite
 * (inline-returns.service.spec.ts) can distinguish "the customer-scoped advisory lock
 * genuinely serialized two captures" from "the mock happened to resolve in the right
 * order" — the exact gap `returns-idempotency.db.spec.ts` closed for
 * ReturnsService.create().
 *
 * Case 1 (driver-cap race, §4 N-5 / HIGH-1): two PARALLEL DRIVER captures on the SAME
 * order, each individually under the order's total, together exceed it. The
 * customer-scoped `pg_advisory_xact_lock` (IdempotencyService#acquireLock) serializes
 * them, so the SECOND to acquire the lock sees the FIRST's already-committed
 * `sumInlineReturnCredit` and is held for approval instead of also being issued —
 * exactly one capture ends up REFUNDED (credit actually released), the other RECEIVED
 * with holdReason DRIVER_CAP, and the released sum never exceeds the order's gross.
 * Without the lock, both could read Σ=0 concurrently and both issue, jointly exceeding
 * the cap — the HIGH-1 bug this test pins shut.
 *
 * Case 2 (returnKey conflict, MED-7): two PARALLEL captures from DIFFERENT customers
 * reusing the SAME returnKey race the real `@@unique([tenantId, returnKey])`
 * constraint — they acquire DIFFERENT customer-scoped locks (keyed on customerId), so
 * nothing serializes them and a genuine P2002 (proximately surfaced as the transaction
 * having been aborted, 25P02, on any further query on that connection) is a real,
 * reproducible race here, not a simulated one. Exactly one capture succeeds; the other
 * must reject with a 409 ConflictException — never a 500, and never silently "replay"
 * the winning customer's row as if it were its own.
 *
 * Constructs a REAL InlineReturnsService via `Object.create` (bypassing Nest DI, same
 * pattern as `returns-idempotency.db.spec.ts` / `orders/order-idempotency-key.db.spec.ts`),
 * wired to REAL PrismaService + IdempotencyService + NumberingService + CreditNotesService
 * + RegulatedLedgerService + InlineReturnsQuoteService + SystemConfigService (no tax-rate
 * row configured ⇒ 0%, keeping totals exact) — every collaborator this capture path
 * actually writes through. `gateway` (Socket.io emits, no DB effect) and `addonService`
 * (the entitlement gate, orthogonal to these two races) and `commissionEngine` (never
 * touched by mintStandaloneInTx — it only applies commission sync on invoice application,
 * which never happens here since the carrying order has no invoice) are the only
 * lightweight fakes, matching the established precedent of faking exactly what the
 * exercised code paths never call.
 *
 * Both products here are priced UNREFERENCED (no Invoice/InvoiceItem exists for the
 * carrying order at all) — the pricing engine falls back to the product's tier/list
 * price, which is exactly what §3.2's "no matching invoice line" branch is for, and
 * sidesteps needing a full invoice fixture chain to prove a lock/race invariant that has
 * nothing to do with invoice matching.
 *
 * Run via `npm run local:test:db` (compose Postgres) — collected only by
 * jest.db.config.js, never the main unit lane.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { NumberingService } from "../import/numbering.service";
import { IdempotencyService } from "../common/idempotency.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("B467 — InlineReturnsService.capture() concurrency, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient; // superuser fixture client — deliberately unscoped
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let svc: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(
    `qa-b467-cap-${run}`,
    "inline-returns-capture-concurrency.db.spec.ts",
  );
  let tenantId = "";
  const orderIds: string[] = [];
  const customerIds: string[] = [];
  const productIds: string[] = [];
  const userIds: string[] = [];

  function driverUser(sub: string): JwtPayload {
    return {
      sub,
      username: `driver-${sub.slice(0, 6)}`,
      role: "DRIVER" as any,
      status: "ACTIVE" as any,
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    };
  }

  /** One product + one driver-owned carrying order (DELIVERED, `total`, on a real route
   * run stop) — no Invoice at all, so every captured item prices UNREFERENCED. */
  async function seedOrder(tag: string, total: number) {
    const product = await raw.product.create({
      data: { name: `${tag} product ${run}`, unit: "each", pricePerUnit: "10.00", tenantId },
    });
    productIds.push(product.id);
    const driver = await raw.user.create({
      data: {
        email: `${tag}-drv-${run}@example.test`,
        username: `${tag}-drv-${run}`,
        role: "DRIVER",
        tenantId,
      },
    });
    userIds.push(driver.id);
    const custUser = await raw.user.create({
      data: {
        email: `${tag}-cust-${run}@example.test`,
        username: `${tag}-cust-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    userIds.push(custUser.id);
    const customer = await raw.customer.create({
      data: {
        userId: custUser.id,
        businessName: `${tag} co`,
        contactName: "B467 Tester",
        tenantId,
      },
    });
    customerIds.push(customer.id);
    const route = await raw.route.create({ data: { name: `${tag} route ${run}`, tenantId } });
    const routeStop = await raw.routeStop.create({
      data: { routeId: route.id, stopNumber: 1, tenantId },
    });
    const routeRun = await raw.routeRun.create({
      data: {
        routeId: route.id,
        driverId: driver.id,
        status: "IN_PROGRESS",
        scheduledDate: new Date(),
        tenantId,
      },
    });
    const routeRunStop = await raw.routeRunStop.create({
      data: {
        routeRunId: routeRun.id,
        routeStopId: routeStop.id,
        customerId: customer.id,
        stopNumber: 1,
        status: "IN_PROGRESS",
        podPhotoUrls: [],
        tenantId,
      },
    });
    const order = await raw.order.create({
      data: {
        customerId: customer.id,
        tenantId,
        status: "DELIVERED",
        total: total.toFixed(2),
        routeRunId: routeRun.id,
        routeRunStopId: routeRunStop.id,
      },
    });
    orderIds.push(order.id);
    return {
      productId: product.id,
      customerId: customer.id,
      driverId: driver.id,
      orderId: order.id,
      routeRunStopId: routeRunStop.id,
    };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const idempotency = new IdempotencyService();
    const numbering = new NumberingService(prisma);
    const ledger = new RegulatedLedgerService(prisma);
    const systemConfig = new SystemConfigService(prisma, new EncryptionService());
    const quoteService = new InlineReturnsQuoteService(prisma, systemConfig);
    // `Object.create` runs no constructor — every instance FIELD the exercised code
    // dereferences must be supplied here (see returns-idempotency.db.spec.ts's note).
    const creditNotes = Object.assign(Object.create(CreditNotesService.prototype), {
      prisma,
      gateway: { emitCreditNoteCreated: jest.fn() },
      ledger,
      commissionEngine: {}, // never touched by mintStandaloneInTx (no invoice application here)
      numbering,
      logger: new Logger(CreditNotesService.name),
    });
    svc = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma,
      gateway: { emitCreditNoteCreated: jest.fn() },
      ledger,
      creditNotes,
      numbering,
      addonService: { hasAddon: async () => true },
      quoteService,
      idempotency,
    });

    tenantId = (await raw.tenant.create({ data: { slug, name: `B467 Cap ${slug}` } })).id;
  }, 120_000);

  afterAll(async () => {
    for (const orderId of orderIds) {
      await raw.orderCreditNote.deleteMany({ where: { orderId } });
      await raw.returnItem.deleteMany({ where: { return: { orderId } } });
      await raw.return.deleteMany({ where: { orderId } });
    }
    await raw.creditNote.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.routeRunStop.deleteMany({ where: { tenantId } });
    await raw.routeRun.deleteMany({ where: { tenantId } });
    await raw.routeStop.deleteMany({ where: { tenantId } });
    await raw.route.deleteMany({ where: { tenantId } });
    await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("case 1: two PARALLEL DRIVER captures that together exceed the order's cap — exactly one is released, and the released sum stays within the cap", async () => {
    const f = await seedOrder("cap", 100);
    const user = driverUser(f.driverId);
    const capture = (returnKey: string) =>
      tenantCtx.run(tenantId, () =>
        svc.capture(
          {
            customerId: f.customerId,
            orderId: f.orderId,
            items: [{ productId: f.productId, qty: 7 }], // 7 * $10 = $70 each
            routeRunStopId: f.routeRunStopId,
            returnKey,
          },
          user,
        ),
      );

    const [r1, r2] = await Promise.all([
      capture(`b467-cap-a-${run}`),
      capture(`b467-cap-b-${run}`),
    ]);

    const results = [r1, r2];
    const refunded = results.filter((r) => r.status === "REFUNDED");
    const held = results.filter((r) => r.status === "RECEIVED" && r.holdReason === "DRIVER_CAP");

    // Exactly one released, one held — never both released (the HIGH-1 bug) and never
    // both held (the lock would be pointless if it over-blocked a return that fits).
    expect(refunded).toHaveLength(1);
    expect(held).toHaveLength(1);
    expect(refunded[0].creditNoteId).toBeTruthy();
    expect(Number(refunded[0].refundAmount)).toBeCloseTo(70, 2);
    expect(held[0].creditNoteId).toBeNull();
    expect(Number(held[0].heldAmount)).toBeCloseTo(70, 2);

    // The money that actually left the ledger (REFUNDED only) never exceeds the order's
    // gross — the held amount is reserved, not released, so it doesn't count here.
    const releasedSum = await raw.return.aggregate({
      where: { orderId: f.orderId, kind: "INLINE", status: "REFUNDED" },
      _sum: { refundAmount: true },
    });
    expect(Number(releasedSum._sum.refundAmount ?? 0)).toBeLessThanOrEqual(100);

    // Real proof the released one actually restocked + minted a credit note (not just a
    // status label) — the SAME transaction that decided "under cap" also committed these.
    expect(await raw.creditNote.count({ where: { customerId: f.customerId } })).toBe(1);
  }, 30_000);

  it("case 2: two PARALLEL captures from DIFFERENT customers reusing the SAME returnKey — exactly one succeeds, the other gets a 409, never a 500, and never replays the winner's row", async () => {
    const fa = await seedOrder("dup-a", 500);
    const fb = await seedOrder("dup-b", 500);
    const sharedKey = `b467-dup-${run}`;
    // OPERATOR, not DRIVER, so no driver-cap complication muddies this race — the two
    // captures use DIFFERENT customerIds, so they take DIFFERENT customer-scoped locks
    // and genuinely run concurrently against the real `@@unique([tenantId, returnKey])`.
    const opUser = (): JwtPayload => ({
      sub: fa.driverId,
      username: "operator",
      role: "OPERATOR" as any,
      status: "ACTIVE" as any,
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    });
    const captureAs = (f: { customerId: string; orderId: string; productId: string }) =>
      tenantCtx.run(tenantId, () =>
        svc.capture(
          {
            customerId: f.customerId,
            orderId: f.orderId,
            items: [{ productId: f.productId, qty: 1 }],
            returnKey: sharedKey,
          },
          opUser(),
        ),
      );

    const outcomes = await Promise.allSettled([captureAs(fa), captureAs(fb)]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Never a 500 (an unmapped/uncaught error) — a real 409 ConflictException.
    const reason: any = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason?.status ?? reason?.getStatus?.()).toBe(409);

    // Exactly one Return row exists for this key, tenant-wide, and it belongs to whichever
    // customer actually won — never a row (or a mutated copy) for the LOSING customer.
    const rows = await raw.return.findMany({ where: { returnKey: sharedKey, kind: "INLINE" } });
    expect(rows).toHaveLength(1);
    const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value;
    expect(rows[0].id).toBe(winner.id);
    expect([fa.customerId, fb.customerId]).toContain(rows[0].customerId);
    const loserCustomerId = rows[0].customerId === fa.customerId ? fb.customerId : fa.customerId;
    // The losing customer never got a Return of their own, and never got silently
    // attributed the winner's row.
    expect(await raw.return.count({ where: { customerId: loserCustomerId, kind: "INLINE" } })).toBe(
      0,
    );
  }, 30_000);
});
