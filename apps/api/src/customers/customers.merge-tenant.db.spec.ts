/**
 * W-763 (SA-903): real-Postgres proof that a customer merge never crosses businesses.
 *
 * A SUPER_ADMIN merge runs with NO tenant, so `forTenant()` is unscoped and a customer of any business loads. Before
 * the fix, merging business B's customer into business A's moved B's orders under A's customer and then deleted B's
 * customer. The merge now refuses with CUSTOMER_MERGE_TENANT_MISMATCH before its transaction, and nothing moves:
 *   - a tenantless merge of two businesses' customers is refused (400);
 *   - a tenant session merging two customers of ANOTHER business is refused (the scoped read 404s first), and
 *     nothing moves.
 *
 * SAFETY: two throwaway `qa-w763-<run>-a|b` tenants (`assertTestTenant`). `afterAll` deletes exactly their rows, in FK
 * order. Collected only by `jest.db.config.js`; run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { BadRequestException, Logger, NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CustomersService } from "./customers.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("W-763 — mergeCustomers stays inside one business on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let customers: CustomersService;
  const run = randomUUID().slice(0, 8);
  const slugs = ["a", "b"].map((s) =>
    assertTestTenant(`qa-w763-${run}-${s}`, "customers.merge-tenant.db.spec.ts"),
  );
  let tenantA = "";
  let tenantB = "";

  async function seedCustomer(tenantId: string, tag: string) {
    const user = await raw.user.create({
      data: {
        email: `${tag}-${run}@example.test`,
        username: `w763-${tag}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await raw.customer.create({
      data: { userId: user.id, businessName: `W763 ${tag}`, contactName: `W763 ${tag}`, tenantId },
    });
    const order = await raw.order.create({
      data: {
        customerId: customer.id,
        status: "PENDING",
        subtotal: "10.00",
        total: "10.00",
        tenantId,
      },
    });
    return { customerId: customer.id, orderId: order.id };
  }

  /** Each seeded order is still on its own customer, and every customer still exists. */
  async function expectNothingMoved(seeds: Array<{ customerId: string; orderId: string }>) {
    for (const s of seeds) {
      const order = await raw.order.findUniqueOrThrow({ where: { id: s.orderId } });
      expect(order.customerId).toBe(s.customerId);
      expect(await raw.customer.findUnique({ where: { id: s.customerId } })).not.toBeNull();
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    // Object.create bypasses Nest DI (the sa218-lock-order.db.spec.ts pattern): the REAL connected prisma, so the
    // merge runs its real reads and, on master, its real writes.
    customers = Object.assign(Object.create(CustomersService.prototype), {
      prisma,
      logger: new Logger("w763-customers"),
    });
    tenantA = (await raw.tenant.create({ data: { slug: slugs[0], name: `W763 ${slugs[0]}` } })).id;
    tenantB = (await raw.tenant.create({ data: { slug: slugs[1], name: `W763 ${slugs[1]}` } })).id;
  }, 120_000);

  afterAll(async () => {
    const tenantId = { in: [tenantA, tenantB].filter(Boolean) };
    await raw.order.deleteMany({ where: { tenantId } });
    await raw.customer.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  it("a tenantless (SUPER_ADMIN) merge of two businesses' customers is refused with the code, and nothing moves", async () => {
    const a = await seedCustomer(tenantA, "a1");
    const b = await seedCustomer(tenantB, "b1");
    const err = await tenantCtx
      .run(null, () => customers.mergeCustomers(a.customerId, b.customerId))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: API_ERROR_CODES.CUSTOMER_MERGE_TENANT_MISMATCH,
    });
    await expectNothingMoved([a, b]);
  }, 60_000);

  it("a tenant session merging two customers of ANOTHER business is refused, and nothing moves", async () => {
    const a1 = await seedCustomer(tenantA, "a2");
    const a2 = await seedCustomer(tenantA, "a3");
    const err = await tenantCtx
      .run(tenantB, () => customers.mergeCustomers(a1.customerId, a2.customerId))
      .then(
        () => null,
        (e: unknown) => e,
      );
    // The scoped read hides another business's customer (404) before the W-763 check runs; either refusal is safe.
    expect(err instanceof NotFoundException || err instanceof BadRequestException).toBe(true);
    await expectNothingMoved([a1, a2]);
  }, 60_000);
});
