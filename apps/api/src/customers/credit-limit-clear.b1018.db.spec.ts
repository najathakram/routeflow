/**
 * B1018 / SA-642 (NEED-DB: run by the prover, never by the builder): a real Postgres proves the three things the mocked specs
 * cannot: (1) `creditLimit: null` written through the same `customerUpdateData` the PATCH uses really leaves the Decimal(10,2)
 * column NULL ("no limit"); (2) 0 is stored as a real 0.00, distinct from NULL; (3) the audit row's `meta` {from, to} JSON
 * round-trips through the AuditLog table, including a null `to`.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`). SAFETY: a throwaway `qa-b1018-<run>` tenant approved by
 * `assertTestTenant`; `afterAll` deletes exactly what this run created; `requireLocalDatabaseUrl()` refuses any non-local host.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { customerUpdateData } from "./customer-update-data";
import { recordCreditLimitChange } from "./credit-limit-audit";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("Customer.creditLimit clear + audit (B1018), real Postgres", () => {
  let prisma: PrismaService;
  let tenantId: string;
  let customerId: string;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    const slug = assertTestTenant(`qa-b1018-${RUN}`, "credit-limit-clear.b1018.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `B1018 ${slug}` } })).id;
    const user = await prisma.user.create({
      data: {
        email: `b1018-${RUN}@example.invalid`,
        username: `b1018-${RUN}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    customerId = (
      await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: "B1018 customer",
          contactName: "B1018",
          tenantId,
          creditLimit: 500,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma?.$disconnect();
  });

  const limit = async () =>
    (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).creditLimit;

  it("null clears the stored limit to NULL; 0 is a real 0.00; undefined leaves the column alone", async () => {
    await prisma.customer.update({
      where: { id: customerId },
      data: customerUpdateData({ creditLimit: null } as never),
    });
    expect(await limit()).toBeNull();

    await prisma.customer.update({
      where: { id: customerId },
      data: customerUpdateData({ creditLimit: 0 } as never),
    });
    expect(Number(await limit())).toBe(0);

    await prisma.customer.update({
      where: { id: customerId },
      data: customerUpdateData({ creditLimit: 250 } as never),
    });
    await prisma.customer.update({
      where: { id: customerId },
      data: customerUpdateData({ phone: "5551234567" } as never),
    });
    expect(Number(await limit())).toBe(250);
  });

  it("the audit row stores {from, to} and a null `to` round-trips", async () => {
    const audit = new AuditService(prisma);
    await recordCreditLimitChange(audit, tenantId, customerId, 250, null, { sub: null });
    await recordCreditLimitChange(audit, tenantId, customerId, null, 750, { sub: null });
    await recordCreditLimitChange(audit, tenantId, customerId, 750, 750, { sub: null }); // unchanged: no row
    const rows = await prisma.auditLog.findMany({
      where: { tenantId, action: "CUSTOMER_CREDIT_LIMIT_CHANGED", entityId: customerId },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => r.meta)).toEqual([
      { from: 250, to: null },
      { from: null, to: 750 },
    ]);
  });
});
