/**
 * B2191 follow-up — DB-lane proof that `Customer.creditLimit` (Decimal(10, 2)) really does accept
 * exactly the DTO's now-enforced max, 99,999,999.99, against a REAL Postgres. The mocked DTO specs
 * (`apps/api/src/customers/dto/credit-limit-bound.b2191.spec.ts`) prove the class-validator SHAPE;
 * only a real column write proves Postgres actually stores that exact value without truncation or
 * rounding.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`; the real
 * connection is built in `beforeAll` (never at collection time) and `requireLocalDatabaseUrl()`
 * refuses any non-local host. SAFETY: the tenant is a throwaway `qa-b2191-<run>` slug approved by
 * `assertTestTenant`; `afterAll` deletes exactly the tenant this run created.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { MAX_DECIMAL_10_2 } from "../common/decimal-bounds.constant";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "Customer.creditLimit — Decimal(10,2) column write (B2191 follow-up), real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let tenantId: string;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      const slug = assertTestTenant(`qa-b2191-${RUN}`, "credit-limit-bound.b2191.db.spec.ts");
      const tenant = await prisma.tenant.create({ data: { slug, name: `B2191 ${slug}` } });
      tenantId = tenant.id;
    });

    afterAll(async () => {
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
      await prisma?.$disconnect();
    });

    it("stores MAX_DECIMAL_10_2 (99,999,999.99) exactly — the DTO's new upper bound is the column's real max, not an arbitrary guess", async () => {
      const user = await prisma.user.create({
        data: {
          email: `b2191-${RUN}@example.invalid`,
          username: `b2191-${RUN}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      const customer = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: "B2191 max credit limit",
          contactName: "B2191",
          tenantId,
          creditLimit: MAX_DECIMAL_10_2,
        },
      });
      expect(Number(customer.creditLimit)).toBe(MAX_DECIMAL_10_2);

      const reloaded = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
      expect(Number(reloaded.creditLimit)).toBe(MAX_DECIMAL_10_2);
    });
  },
);
