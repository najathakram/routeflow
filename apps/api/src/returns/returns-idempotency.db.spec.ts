/**
 * F5 round 3, item 4 (independent review round 3, PR-2) — real-Postgres proof that
 * `ReturnsService.create()`'s check-then-act guard actually serializes on real advisory-lock
 * behavior through Prisma's `pg` adapter, which a jest-mocked Prisma client cannot prove: a
 * mocked `$executeRaw` just resolves immediately regardless of what SQL it was handed, so
 * nothing in the mocked unit suite (`returns-idempotency.spec.ts`) can distinguish "the lock
 * genuinely blocked a second session" from "the mock happened to resolve in the right order".
 *
 * Two cases, matching the ruling exactly:
 *   (a) two PARALLEL identical submissions (same Idempotency-Key) create exactly ONE return.
 *   (b) eight PARALLEL submissions with DISTINCT keys all succeed independently — proving the
 *       transaction-scoped `pg_advisory_xact_lock` (IdempotencyService#acquireLock) never
 *       serializes unrelated keys against each other, the whole reason round 2 (N1) retired the
 *       round-1 dedicated connection pool in favor of a lock scoped to each call's OWN
 *       transaction connection.
 *
 * Constructs a REAL `ReturnsService` via `Object.create` (bypassing Nest DI, exactly like
 * `orders/order-idempotency-key.db.spec.ts`) wired to a REAL `PrismaService` + REAL
 * `IdempotencyService` (round 2/3 made it take no constructor dependencies at all) + REAL
 * `NumberingService` — only the non-DB collaborators (gateway, ledger, credit notes) are
 * lightweight fakes, since `create()` never calls them on the paths these two cases exercise.
 *
 * Run via `npm run local:test:db` (compose Postgres) — collected only by jest.db.config.js,
 * never the main unit lane.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ReturnsService } from "./returns.service";
import { IdempotencyService } from "../common/idempotency.service";
import { NumberingService } from "../import/numbering.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

interface Fx {
  tenantId: string;
  userId: string;
  orderId: string;
  productId: string;
}

describeDb("F5 round 3 item 4 — ReturnsService.create() idempotency lock, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient; // superuser fixture client — deliberately unscoped
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let idempotency: IdempotencyService;
  let svc: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-retidem-${run}`, "returns-idempotency.db.spec.ts");
  let tenantId = "";
  const orderIds: string[] = [];
  // Every (userId, orderId, key) this file mints — cleaned up by exact hash in afterAll rather
  // than a blanket delete, since IdempotencyKey is a GLOBAL table other concurrent sessions'
  // DB-lane runs may also be writing to.
  const mintedKeys: { userId: string; orderId: string; key: string }[] = [];

  async function seed(tag: string, orderedQty: number): Promise<Fx> {
    const user = await raw.user.create({
      data: {
        email: `${tag}-${run}@example.test`,
        username: `${tag}-${run}`,
        role: "DRIVER",
        tenantId,
      },
    });
    const customer = await raw.customer.create({
      data: {
        userId: user.id,
        businessName: `${tag} co`,
        contactName: "Return Lock Tester",
        tenantId,
      },
    });
    const product = await raw.product.create({
      data: { name: `${tag} product`, unit: "each", pricePerUnit: "5.00", tenantId },
    });
    const order = await raw.order.create({
      data: { customerId: customer.id, tenantId, status: "DELIVERED", total: "50.00" },
    });
    await raw.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        qty: orderedQty,
        unitPrice: "5.00",
        tenantId,
      },
    });
    orderIds.push(order.id);
    return { tenantId, userId: user.id, orderId: order.id, productId: product.id };
  }

  function createOnce(f: Fx, key: string, qty: number) {
    mintedKeys.push({ userId: f.userId, orderId: f.orderId, key });
    return tenantCtx.run(f.tenantId, () =>
      svc.create(
        { orderId: f.orderId, reason: "DAMAGED", items: [{ productId: f.productId, qty }] },
        f.userId,
        "DRIVER",
        key,
      ),
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    idempotency = new IdempotencyService();
    // `Object.create` runs no constructor, so every instance FIELD the exercised code
    // dereferences must be supplied here — `logger` included (a class field, so it lives on
    // the instance, not the prototype; see order-idempotency-key.db.spec.ts's own note).
    svc = Object.assign(Object.create(ReturnsService.prototype), {
      prisma,
      gateway: { emitReturnCreated: jest.fn() },
      ledger: {},
      creditNotes: {},
      numbering: new NumberingService(prisma),
      idempotency,
      logger: new Logger(ReturnsService.name),
    });

    tenantId = (await raw.tenant.create({ data: { slug, name: `Ret Idem ${slug}` } })).id;
  }, 120_000);

  afterAll(async () => {
    for (const orderId of orderIds) {
      await raw.returnItem.deleteMany({ where: { return: { orderId } } });
      await raw.return.deleteMany({ where: { orderId } });
      await raw.orderItem.deleteMany({ where: { orderId } });
    }
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.customer.deleteMany({ where: { tenantId } });
    await raw.product.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({ where: { tenantId } });
    for (const { userId, orderId, key } of mintedKeys) {
      const hash = idempotency.hashFor(key, tenantId, `returns.create:${userId}:${orderId}`);
      await raw.$executeRaw`DELETE FROM "IdempotencyKey" WHERE "keyHash" = ${hash}`;
    }
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("item 4a: two PARALLEL identical submissions (same key) create exactly ONE return", async () => {
    const f = await seed("case-a", 10);
    const key = `key-${run}-a`;

    const [r1, r2] = await Promise.all([createOnce(f, key, 2), createOnce(f, key, 2)]);

    expect(r1.id).toBe(r2.id);
    expect(await raw.return.count({ where: { orderId: f.orderId } })).toBe(1);
  }, 20_000);

  it("item 4b: eight PARALLEL submissions with DISTINCT keys all succeed independently", async () => {
    const f = await seed("case-b", 100);
    const keys = Array.from({ length: 8 }, (_, i) => `key-${run}-b-${i}`);

    const results = await Promise.all(keys.map((k) => createOnce(f, k, 1)));

    // 8 genuinely distinct rows — none silently collapsed onto another, and none blocked
    // behind a DIFFERENT key's holder (a stuck lock here would time out this test).
    expect(new Set(results.map((r) => r.id)).size).toBe(8);
    expect(await raw.return.count({ where: { orderId: f.orderId } })).toBe(8);
  }, 20_000);
});
