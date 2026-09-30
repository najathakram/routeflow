/**
 * P4-c — T3/R4 (2026-09-03-imp-p4-guard-order-findunique-pins/brief.md), DB lane.
 * REGRESSION PINS ONLY — every case here is already GREEN before the fix and is
 * deliberately kept out of the red-gate file (tenant-findunique.db.spec.ts, which
 * holds only the 8 red `findUniqueOrThrow` cases). Pins `findUnique` for Customer,
 * Product, Order, Invoice under BOTH `prisma.forTenant()` and
 * `prisma.tenantTransaction()`, plus the RLS session-variable hand-off
 * (`current_setting('app.current_tenant_id', true)`).
 *
 * Run via `npm run local:test:db` (compose Postgres) — never `local:*` from an
 * automated engine; this file is collected only by jest.db.config.js.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "./prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

type ModelName = "customer" | "product" | "order" | "invoice";

interface Fixture {
  tenantId: string;
  userId: string;
  customerId: string;
  productId: string;
  orderId: string;
  invoiceId: string;
}

describeDb(
  "T3/R4 — cross-tenant findUnique regression pins (Customer, Product, Order, Invoice)",
  () => {
    // Nothing env-dependent may run at collection time (db-lane.db.spec.ts's rule):
    // Jest evaluates a `describe.skip` body, so any construction here would throw
    // even when the lane is meant to be skipped. Everything below lives in
    // beforeAll/it callbacks.
    let pool: Pool;
    let raw: PrismaClient; // superuser fixture client — deliberately unscoped
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;

    // `-pins` suffix so this file's fixture tenants can never collide with the
    // red-bar file's when both run in the same db lane.
    const runSuffix = randomUUID().slice(0, 8);
    const tenantASlug = assertTestTenant(
      `qa-pin-${runSuffix}-pins-a`,
      "tenant-findunique-pins.db.spec.ts",
    );
    const tenantBSlug = assertTestTenant(
      `qa-pin-${runSuffix}-pins-b`,
      "tenant-findunique-pins.db.spec.ts",
    );

    let a: Fixture;
    let b: Fixture;

    async function seedTenant(slug: string): Promise<Fixture> {
      const tenant = await raw.tenant.create({ data: { slug, name: `Pin test ${slug}` } });
      const user = await raw.user.create({
        data: {
          email: `${slug}@example.test`,
          username: slug,
          role: "CUSTOMER",
          tenantId: tenant.id,
        },
      });
      const customer = await raw.customer.create({
        data: {
          userId: user.id,
          businessName: `${slug} co`,
          contactName: "Pin Tester",
          tenantId: tenant.id,
        },
      });
      const product = await raw.product.create({
        data: { name: `${slug} widget`, unit: "EACH", pricePerUnit: "1.00", tenantId: tenant.id },
      });
      const order = await raw.order.create({
        data: { customerId: customer.id, tenantId: tenant.id },
      });
      const invoice = await raw.invoice.create({
        data: {
          invoiceNumber: `INV-${slug}`,
          customerId: customer.id,
          subtotal: "1.00",
          total: "1.00",
          tenantId: tenant.id,
        },
      });
      return {
        tenantId: tenant.id,
        userId: user.id,
        customerId: customer.id,
        productId: product.id,
        orderId: order.id,
        invoiceId: invoice.id,
      };
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx); // opens its own pool off the same DATABASE_URL
      await prisma.$connect();

      a = await seedTenant(tenantASlug);
      b = await seedTenant(tenantBSlug);
      // Explicit hook timeout: the lane now runs this file in parallel with its
      // sibling tenant-findunique.db.spec.ts, and on a cold cache (fresh ts-jest
      // compile + two Prisma engine starts at once) the seed exceeds the config's 30s
      // default — verified: 17/17 cases failed on "Exceeded timeout ... for a hook".
    }, 120_000);

    // Explicit hook timeout: teardown is 12 sequential deleteMany + two $disconnect +
    // pool.end(); on a cold lane run in parallel with the sibling file it exceeds the
    // config's 30s default.
    afterAll(async () => {
      for (const f of [a, b]) {
        if (!f) continue;
        await raw.invoice.deleteMany({ where: { id: f.invoiceId } });
        await raw.order.deleteMany({ where: { id: f.orderId } });
        await raw.product.deleteMany({ where: { id: f.productId } });
        await raw.customer.deleteMany({ where: { id: f.customerId } });
        await raw.user.deleteMany({ where: { id: f.userId } });
        await raw.tenant.deleteMany({ where: { id: f.tenantId } });
      }
      await prisma.$disconnect();
      await raw.$disconnect();
      await pool.end();
    }, 120_000);

    function runAsTenantA<T>(fn: () => Promise<T>): Promise<T> {
      return tenantCtx.run(a.tenantId, fn);
    }

    const MODELS: Array<{ name: ModelName; ownId: () => string; foreignId: () => string }> = [
      { name: "customer", ownId: () => a.customerId, foreignId: () => b.customerId },
      { name: "product", ownId: () => a.productId, foreignId: () => b.productId },
      { name: "order", ownId: () => a.orderId, foreignId: () => b.orderId },
      { name: "invoice", ownId: () => a.invoiceId, foreignId: () => b.invoiceId },
    ];

    // ── REGRESSION PINS (already green — NOT part of the red bar) ─────────────────
    describe("REGRESSION PINS (green before the fix)", () => {
      describe("(a) prisma.forTenant() — scoped as tenant A", () => {
        for (const { name, ownId, foreignId } of MODELS) {
          it(`${name}: findUnique returns the row for tenant A's own id, null for tenant B's id`, async () => {
            await runAsTenantA(async () => {
              const client = prisma.forTenant() as unknown as Record<
                ModelName,
                { findUnique(args: { where: { id: string } }): Promise<{ id: string } | null> }
              >;
              const own = await client[name].findUnique({ where: { id: ownId() } });
              const foreign = await client[name].findUnique({ where: { id: foreignId() } });
              expect(own?.id).toBe(ownId());
              expect(foreign).toBeNull();
            });
          });
        }
      });

      describe("(b) prisma.tenantTransaction() — scoped as tenant A", () => {
        for (const { name, ownId, foreignId } of MODELS) {
          it(`${name}: findUnique returns the row for tenant A's own id, null for tenant B's id`, async () => {
            await runAsTenantA(() =>
              prisma.tenantTransaction(async (tx: any) => {
                const own = await tx[name].findUnique({ where: { id: ownId() } });
                const foreign = await tx[name].findUnique({ where: { id: foreignId() } });
                expect(own?.id).toBe(ownId());
                expect(foreign).toBeNull();
              }),
            );
          });
        }
      });

      it("(c) tenantTransaction sets current_setting('app.current_tenant_id', true) to tenant A's id inside the transaction (RLS hand-off armed)", async () => {
        let seen: string | undefined;
        await runAsTenantA(() =>
          prisma.tenantTransaction(async (tx: any) => {
            const rows = await tx.$queryRaw<
              { v: string }[]
            >`SELECT current_setting('app.current_tenant_id', true) AS v`;
            seen = rows[0]?.v;
          }),
        );
        expect(seen).toBe(a.tenantId);
      });
    });
  },
);
