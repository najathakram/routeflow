/**
 * W-767 (SA-908) — real-Postgres proof of the class and of the refusal.
 *
 * A tenantless SUPER_ADMIN runs with no business in the session, so `forTenant()` is unscoped: the REAL
 * `PATCH /customers/:id` write (CustomersController#update -> CustomersService.update) changes ANOTHER business's
 * customer. TenantRequiredInterceptor, around that same handler:
 *   - DARK (shipping): lets it through. The cross-business write happens; this is the class, observed.
 *   - ENFORCED (the later flip): 403 TENANT_CONTEXT_REQUIRED before the handler, and the row is unchanged.
 *
 * WHY THE DB LANE: the unscoped write is only real against Postgres. SAFETY: a throwaway `qa-w767-<run>` tenant
 * (`assertTestTenant`); `afterAll` deletes exactly its rows. Collected only by `jest.db.config.js`.
 */
import { randomUUID } from "crypto";
import { ForbiddenException, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { defer, lastValueFrom } from "rxjs";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { CustomersController } from "../customers/customers.controller";
import { CustomersService } from "../customers/customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "./tenant-context.service";
import { TenantRequiredInterceptor } from "./tenant-required.interceptor";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("W-767 — a tenantless SUPER_ADMIN write on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let customers: CustomersService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-w767-${run}`, "tenant-required.db.spec.ts");
  let tenantId = "";

  async function seedCustomer(tag: string) {
    const user = await raw.user.create({
      data: {
        email: `${tag}-${run}@example.test`,
        username: `w767-${tag}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    return raw.customer.create({
      data: { userId: user.id, businessName: `W767 ${tag}`, contactName: "Original", tenantId },
    });
  }

  /** The interceptor around the REAL handler's metadata; `next` runs the real service write tenantless. */
  function patchAsTenantlessSuperAdmin(mode: "dark" | "enforced", customerId: string) {
    const interceptor = new TenantRequiredInterceptor(new Reflector());
    interceptor.mode = mode;
    const req = {
      method: "PATCH",
      route: { path: "/api/v1/customers/:id" },
      user: { sub: "sa-w767", role: "SUPER_ADMIN", tenantId: null },
    };
    const context = {
      getType: () => "http",
      getHandler: () => CustomersController.prototype.update,
      getClass: () => CustomersController,
      switchToHttp: () => ({ getRequest: () => req }),
    } as any;
    const next = {
      handle: () =>
        defer(() =>
          tenantCtx.run(null, () =>
            customers.update(customerId, { contactName: "Changed" } as any),
          ),
        ),
    };
    // async: an enforced refusal throws synchronously inside intercept(); this turns it into a rejection.
    return tenantCtx.run(null, async () => lastValueFrom(interceptor.intercept(context, next)));
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    customers = Object.assign(Object.create(CustomersService.prototype), {
      prisma,
      logger: new Logger("w767-customers"),
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `W767 ${slug}` } })).id;
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  it("DARK (shipping): the tenantless write reaches another business's customer (the class, observed) and warns", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const c = await seedCustomer("dark");
      await patchAsTenantlessSuperAdmin("dark", c.id);
      expect((await raw.customer.findUniqueOrThrow({ where: { id: c.id } })).contactName).toBe(
        "Changed",
      );
      expect(
        warn.mock.calls.some(([m]) => String(m).includes("would-deny PATCH /api/v1/customers/:id")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

  it("ENFORCED (the flip): 403 TENANT_CONTEXT_REQUIRED before the handler, and nothing is written", async () => {
    const c = await seedCustomer("enforced");
    const err = await patchAsTenantlessSuperAdmin("enforced", c.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: API_ERROR_CODES.TENANT_CONTEXT_REQUIRED,
    });
    expect((await raw.customer.findUniqueOrThrow({ where: { id: c.id } })).contactName).toBe(
      "Original",
    );
  }, 60_000);
});
