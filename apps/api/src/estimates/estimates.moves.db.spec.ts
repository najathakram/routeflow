/**
 * SA-1263 A1 (W-1335) — DB-lane pins for the estimate state machine: V7 (a voided quote never becomes an invoice)
 * and T4 (two concurrent reverts leave exactly revision 2).
 *
 * WHY THE DB LANE: a mocked `updateMany` cannot prove a race, and cannot prove that no invoice row exists. This
 * drives the REAL `EstimatesService` over a REAL `PrismaService` (compose Postgres). Collected only by
 * `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 *
 * SAFETY: every tenant is a throwaway `qa-w1335-<run>-<n>` slug, approved by `assertTestTenant`; `afterAll`
 * deletes exactly the rows this run created, in FK order.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { UserRole } from "@prisma/client";
import { EstimatesService } from "./estimates.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { NO_PRICE_RIGHTS } from "../common/testing/no-rights-actor";

/** Custom lines with a typed price need price-edit rights (SA-1034 rule 4); TENANT_ADMIN holds them. */
const ADMIN_ACTOR = { ...NO_PRICE_RIGHTS, role: UserRole.TENANT_ADMIN };

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);

describeDb("SA-1263 A1 estimate moves — real Postgres (V7, T4)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: EstimatesService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EstimatesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: EntitlementAuthority,
          useValue: { can: () => Promise.resolve(false) },
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: RegulatedLedgerService, useValue: {} }, // no tracked category on the seeded line
      ],
    }).compile();
    service = module.get(EstimatesService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask the test's own result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.estimate.updateMany({ where: { tenantId }, data: { invoiceId: null } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.estimate.deleteMany({ where: { tenantId } });
    await prisma.numberingSequence.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  /** One test tenant, one customer and one open (DRAFT) one-line quote. */
  async function seedQuote(): Promise<{ tenantId: string; estimateId: string }> {
    const slug = assertTestTenant(
      `qa-w1335-${RUN_SUFFIX}-${createdTenantIds.length + 1}`,
      "estimates.moves.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `W1335 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const idBase = `${tenant.id}-cust`;
    const user = await prisma.user.create({
      data: {
        email: `${idBase}@example.invalid`,
        username: idBase,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "Acme W1335 customer",
        contactName: "Acme contact",
        tenantId: tenant.id,
      },
    });
    const created = await tenantCtx.run(tenant.id, () =>
      service.create(
        {
          customerId: customer.id,
          items: [{ description: "widget", qty: 2, unitPrice: 10 }],
        } as any,
        ADMIN_ACTOR,
      ),
    );
    return { tenantId: tenant.id, estimateId: created.id };
  }

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  it("V7 a voided quote can be neither accepted nor converted: accept refuses naming Declined, no invoice row", async () => {
    const { tenantId, estimateId } = await seedQuote();
    await inTenant(tenantId, () => service.send(estimateId));
    await inTenant(tenantId, () => service.voidEstimate(estimateId)); // A1: a void is still stored as DECLINED

    // Run the whole chain whatever each step answers, so the invoice count is the evidence.
    const accepted = await inTenant(tenantId, () => service.accept(estimateId)).then(
      () => "accepted",
      (e: Error) => e.message,
    );
    await inTenant(tenantId, () => service.convertToInvoice(estimateId, ADMIN_ACTOR)).catch(
      () => undefined,
    );

    const invoices = await prisma.invoice.count({ where: { tenantId } });
    expect({ invoices, accepted }).toEqual({
      invoices: 0,
      accepted: "Declined estimates cannot be re-accepted",
    });
    const row = await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId } });
    expect(row.status).toBe("DECLINED");
  }, 60_000);

  it("T4 two concurrent reverts of a SENT quote: exactly one wins and the revision is exactly 2", async () => {
    const { tenantId, estimateId } = await seedQuote();
    await inTenant(tenantId, () => service.send(estimateId));

    const settled = await Promise.allSettled([
      inTenant(tenantId, () => service.revertToDraft(estimateId)),
      inTenant(tenantId, () => service.revertToDraft(estimateId)),
    ]);

    const row = await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId } });
    expect({
      won: settled.filter((s) => s.status === "fulfilled").length,
      status: row.status,
      revision: row.revision,
    }).toEqual({ won: 1, status: "DRAFT", revision: 2 });
  }, 60_000);
});
