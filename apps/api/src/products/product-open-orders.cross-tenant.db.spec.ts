/**
 * Row 748(b) DB-lane proof (real Postgres, throwaway `qa-*` tenants) for the service layer only:
 * `ProductOpenOrdersService.getOpenOrders` answers "not found" for a product id that belongs to another
 * tenant, and a tenant's own card still lists its own line. It does not cover the controller or guards,
 * and it does not seed a second tenant's lines under the same product id.
 *
 * Run by the DB lane (`npm run local:test:db`); collected only by `jest.db.config.js`. `requireLocalDatabaseUrl()`
 * refuses any non-local host; every tenant is a `qa-*` slug approved by `assertTestTenant`.
 */
import { NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { ProductOpenOrdersService } from "./product-open-orders.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;

describeDb("product open-orders card is tenant-scoped (row 748b) - real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: ProductOpenOrdersService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    service = new ProductOpenOrdersService(prisma);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.orderItem.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  interface World {
    tenantId: string;
    productId: string;
  }

  /** A tenant with one customer, one product and one PENDING order for 5 pieces of it. */
  async function seedWorld(label: string): Promise<World> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-oo748-${RUN}-${seq}-${label}`,
      "product-open-orders.cross-tenant.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `oo748 ${slug}` } });
    tenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `c-${RUN}-${seq}@example.test`,
        username: `c-${RUN}-${seq}`,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `Acme Retail ${label}`,
        contactName: "748 Tester",
        tenantId: tenant.id,
      },
    });
    const product = await prisma.product.create({
      data: {
        tenantId: tenant.id,
        name: `Widget ${label} ${RUN}`,
        unit: "each",
        pricePerUnit: "2.00",
      } as never,
      select: { id: true },
    });
    await prisma.order.create({
      data: {
        customerId: customer.id,
        tenantId: tenant.id,
        status: "PENDING",
        subtotal: "10.00",
        total: "10.00",
        lineItems: {
          create: [
            {
              tenantId: tenant.id,
              productId: product.id,
              qty: 5,
              unitPrice: "2.00",
              subtotal: "10.00",
              position: 0,
            },
          ],
        },
      },
    });
    return { tenantId: tenant.id, productId: product.id };
  }

  it("lists a tenant's own open lines", async () => {
    const a = await seedWorld("own");
    const res = await tenantCtx.run(a.tenantId, () => service.getOpenOrders(a.productId, 200));
    expect(res.lines).toHaveLength(1);
    expect(res.summary.totalQty).toBe(5);
  });

  it("treats another tenant's product id as not found", async () => {
    const a = await seedWorld("a");
    const b = await seedWorld("b");
    await expect(
      tenantCtx.run(a.tenantId, () => service.getOpenOrders(b.productId, 200)),
    ).rejects.toBeInstanceOf(NotFoundException);
    // ...and the owner still sees its own line, so the refusal is scoping, not a broken product.
    const own = await tenantCtx.run(b.tenantId, () => service.getOpenOrders(b.productId, 200));
    expect(own.lines).toHaveLength(1);
  });
});
