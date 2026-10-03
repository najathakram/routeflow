/**
 * B1018 / SA-642 (NEED-DB: run by the prover, never by the builder): a real Postgres proves the three things the mocked specs
 * cannot: (1) `creditLimit: null` written through the same `customerUpdateData` the PATCH uses really leaves the Decimal(10,2)
 * column NULL ("no limit"); (2) 0 is stored as a real 0.00, distinct from NULL; (3) the audit row's `meta` {from, to} JSON
 * round-trips through the AuditLog table, including a null `to`; (4) THROUGH THE REAL CREDIT GUARD (SA-642a): a limit of 500 refuses
 * an order over 500, the same order is allowed once the limit is cleared to null, and a limit of 0 refuses any positive exposure.
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
import { assertWithinCreditLimit } from "../orders/credit-limit-guard";
import { API_ERROR_CODES } from "../common/api-error-codes";

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

  /** The B585 / edit guard on a brand-new order (`currentOrderId = null`) for this customer, checking enabled. */
  const check = (projectedTotal: number) =>
    assertWithinCreditLimit(prisma, customerId, null, projectedTotal, true, { action: "order" });
  const setLimit = (creditLimit: number | null) =>
    prisma.customer.update({
      where: { id: customerId },
      data: customerUpdateData({ creditLimit } as never),
    });
  const refusal = async (p: Promise<unknown>) => {
    const err: any = await p.catch((e) => e);
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.CREDIT_LIMIT_EXCEEDED });
    return err.getResponse() as { limit: number; exposure: number };
  };

  it("through the real credit guard: 500 refuses an order over 500, null allows the same order, 0 refuses any positive exposure", async () => {
    await setLimit(500);
    expect(await refusal(check(600))).toMatchObject({ limit: 500, exposure: 600 });
    await expect(check(500)).resolves.toBeUndefined(); // exactly at the limit is allowed

    await setLimit(null); // cleared: "no limit", the guard returns before any check
    await expect(check(600)).resolves.toBeUndefined();
    await expect(check(1_000_000)).resolves.toBeUndefined();

    await setLimit(0); // a REAL $0 limit
    expect(await refusal(check(0.01))).toMatchObject({ limit: 0, exposure: 0.01 });
    await expect(check(0)).resolves.toBeUndefined(); // no exposure at all is not over a $0 limit
  });
});
