/**
 * SA-1124 PR-0 on REAL Postgres: `20261110000000_order_review_flags_offline` adds the `OrderReviewFlag` table and
 * `Order.offlineCreatedAt`. The DATABASE decides, so these are raw Prisma inserts (the writer is PR-1a's).
 *
 *  - M2: `OrderReviewFlag_resolution_pair` refuses `resolvedAt` set with `resolution` NULL, and the reverse (23514)
 *  - `OrderReviewFlag_resolution_len` refuses a 2-character and a 501-character resolution; 3 and 500 are written
 *  - `tenantId` is NOT NULL from day one (23502): a flag with no tenant is not written
 *  - the FKs: deleting the order cascades its flags; deleting the line keeps the flag with `orderItemId` NULL;
 *    deleting the resolver keeps the flag with `resolvedById` NULL
 *  - `Order.offlineCreatedAt` is nullable and round-trips a device time
 *
 * SAFETY: a throwaway `qa-sa1124-<run>` tenant (`assertTestTenant`); afterAll deletes exactly this tenant's rows, in
 * FK order. Collected only by `jest.db.config.js`; run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

/** The SQLSTATE behind a Prisma adapter error (23514 = check_violation, 23502 = not_null_violation). */
function sqlState(err: any): string | undefined {
  return (
    err?.meta?.driverAdapterError?.cause?.originalCode ?? err?.cause?.originalCode ?? err?.code
  );
}

/** Resolves to the SQLSTATE of a rejected write (undefined when it was written). */
const stateOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e) => sqlState(e),
  );

describeDb("SA-1124 PR-0 OrderReviewFlag schema — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-sa1124-${run}`, "order-review-flag-schema.db.spec.ts");
  let tenantId = "";
  let customerId = "";
  let staffId = "";

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantId = (await raw.tenant.create({ data: { slug, name: `SA1124 ${slug}` } })).id;
    const buyer = await raw.user.create({
      data: {
        email: `sa1124-${run}@example.test`,
        username: `sa1124-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    customerId = (
      await raw.customer.create({
        data: { userId: buyer.id, businessName: "SA1124", contactName: "SA1124", tenantId },
      })
    ).id;
    staffId = (
      await raw.user.create({
        data: {
          email: `sa1124-staff-${run}@example.test`,
          username: `sa1124-staff-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      await raw.orderReviewFlag.deleteMany({ where: { tenantId } });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.order.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
    }
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  const newOrder = (extra: { offlineCreatedAt?: Date } = {}) =>
    raw.order.create({
      data: { customerId, status: "DRAFT", subtotal: "0", total: "0", tenantId, ...extra },
    });
  const flag = (orderId: string, extra: Record<string, unknown> = {}) =>
    raw.orderReviewFlag.create({
      data: {
        tenantId,
        orderId,
        kind: "PRICE_CHANGED_OFFLINE",
        detail: { lineIndex: 0, shown: 10, now: 12 },
        ...extra,
      } as never,
    });

  it("the two CHECKs are installed", async () => {
    const { rows } = await pool.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"OrderReviewFlag"'::regclass AND contype = 'c' ORDER BY conname`,
    );
    expect(rows.map((r) => r.conname)).toEqual([
      "OrderReviewFlag_resolution_len",
      "OrderReviewFlag_resolution_pair",
    ]);
  });

  it("every foreign key column has an index that leads with it (a parent delete does not scan the table)", async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'OrderReviewFlag'`,
    );
    const defs: string[] = rows.map((r) => r.indexdef);
    for (const col of ["orderId", "orderItemId", "resolvedById"]) {
      expect(defs.some((d) => d.includes(`("${col}")`))).toBe(true);
    }
  });

  it("M2: a resolvedAt without a resolution is refused, and a resolution without a resolvedAt", async () => {
    const order = await newOrder();
    expect(await stateOf(flag(order.id, { resolvedAt: new Date() }))).toBe("23514");
    expect(await stateOf(flag(order.id, { resolution: "looked at it" }))).toBe("23514");
  });

  it("a resolved flag (both set) and an open flag (both NULL) are written", async () => {
    const order = await newOrder();
    const open = await flag(order.id);
    expect(open.resolvedAt).toBeNull();
    expect(open.resolution).toBeNull();
    const resolved = await flag(order.id, {
      resolvedAt: new Date(),
      resolvedById: staffId,
      resolution: "price confirmed by phone",
    });
    expect(resolved.resolution).toBe("price confirmed by phone");
  });

  it("the resolution length is 3..500: 2 and 501 are refused, 3 and 500 are written", async () => {
    const order = await newOrder();
    const withResolution = (resolution: string) =>
      flag(order.id, { resolvedAt: new Date(), resolution });
    expect(await stateOf(withResolution("ab"))).toBe("23514");
    expect(await stateOf(withResolution("x".repeat(501)))).toBe("23514");
    expect((await withResolution("abc")).resolution).toBe("abc");
    expect((await withResolution("x".repeat(500))).resolution).toHaveLength(500);
  });

  it("tenantId is NOT NULL: a flag with no tenant is not written", async () => {
    const order = await newOrder();
    await expect(
      pool.query(
        `INSERT INTO "OrderReviewFlag" ("id", "orderId", "kind", "detail") VALUES ($1, $2, 'RESTRICTED', '{}'::jsonb)`,
        [randomUUID(), order.id],
      ),
    ).rejects.toMatchObject({ code: "23502" });
  });

  it("deleting the order cascades its flags", async () => {
    const order = await newOrder();
    await flag(order.id);
    await flag(order.id, { kind: "OPEN_ORDER_EXISTS", detail: { existingOrderId: "x" } });
    await raw.order.delete({ where: { id: order.id } });
    expect(await raw.orderReviewFlag.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("deleting the line keeps the flag with orderItemId NULL; deleting the resolver keeps resolvedById NULL", async () => {
    const order = await newOrder();
    const line = await raw.orderItem.create({
      data: { orderId: order.id, qty: 1, unitPrice: "5", tenantId },
    });
    const resolver = await raw.user.create({
      data: {
        email: `sa1124-gone-${run}@example.test`,
        username: `sa1124-gone-${run}`,
        role: "OPERATOR",
        tenantId,
      },
    });
    const kept = await flag(order.id, {
      orderItemId: line.id,
      resolvedAt: new Date(),
      resolvedById: resolver.id,
      resolution: "seen and fine",
    });
    await raw.orderItem.delete({ where: { id: line.id } });
    await raw.user.delete({ where: { id: resolver.id } });
    const after = await raw.orderReviewFlag.findUniqueOrThrow({ where: { id: kept.id } });
    expect(after.orderItemId).toBeNull();
    expect(after.resolvedById).toBeNull();
    expect(after.resolution).toBe("seen and fine");
  });

  it("Order.offlineCreatedAt is nullable and round-trips a device time", async () => {
    const online = await newOrder();
    expect(online.offlineCreatedAt).toBeNull();
    const when = new Date("2026-11-07T14:30:00.000Z");
    const offline = await newOrder({ offlineCreatedAt: when });
    expect(offline.offlineCreatedAt?.toISOString()).toBe(when.toISOString());
  });
});
