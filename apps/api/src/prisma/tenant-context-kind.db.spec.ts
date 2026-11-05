/**
 * SA-1105 row K-3 (real Postgres, the DB lane): the #2872 scenario on `Customer`. A SUPER_ADMIN, with no business in
 * context, creates a tenant-owned row through `forTenant()` with no `tenantId`. The guard reports it once and
 * passes the write through unchanged (dark), so the real database decides: `Customer_tenantId_nn` rejects the NULL
 * tenant (23514). The warn is the early, data-free signal; nothing about customers changes. Collected only by jest.db.config.js.
 */
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "./prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("K-3 SUPER_ADMIN create without tenantId on Customer (real Postgres)", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let tenantId: string;
  let userId: string;
  const slug = assertTestTenant(
    `qa-ctxkind-${randomUUID().slice(0, 8)}`,
    "tenant-context-kind.db.spec.ts",
  );

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    const tenant = await raw.tenant.create({ data: { slug, name: `Ctx kind ${slug}` } });
    tenantId = tenant.id;
    const user = await raw.user.create({
      data: { email: `${slug}@example.test`, username: slug, role: "CUSTOMER", tenantId },
    });
    userId = user.id;
  }, 120_000);

  afterAll(async () => {
    await raw.user.deleteMany({ where: { id: userId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  it("passes the write through unchanged and logs TENANT_CONTEXT_MISSING once, with no data in the line", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const attempt = ctx.run(
        null,
        () =>
          prisma.forTenant().customer.create({
            data: { userId, businessName: "Ctx Kind Co", contactName: "Pat Tester" },
          }),
        "SUPER_ADMIN",
        "CustomersController.create",
      );
      // dark: the write is passed through as given, so the DB check constraint is what refuses it
      await expect(attempt).rejects.toMatchObject({
        message: expect.stringContaining("Customer_tenantId_nn"),
      });
      const lines = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith("TENANT_CONTEXT_MISSING kind="));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/kind=SUPER_ADMIN model=Customer op=create/);
      expect(lines[0]).not.toMatch(/Ctx Kind Co|Pat Tester/);
    } finally {
      warn.mockRestore();
    }
  });
});
