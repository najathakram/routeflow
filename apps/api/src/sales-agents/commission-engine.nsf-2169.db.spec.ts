/**
 * #2169 (SA-395) — NEED-DB, NOT executed here (project rule: "Builders post NEED-DB first — never
 * run DB specs on the compose stack; the prover owns it"). Executed proof for
 * `CommissionEngineService`'s new `items` select (`systemKind: true`, added in this PR) — per the
 * project memory rule "a Prisma select change needs an executed query; mocks accept non-existent
 * columns", the unit spec (commission-engine.service.spec.ts) only proves the pure filtering logic
 * against a hand-rolled fake `db`, which would accept `systemKind` in its `select` even if the
 * column did not exist. This file runs the REAL read path (`syncInvoiceCommissionSafe`, the
 * public entry point that performs the `runSync` `findUnique` with that select) against real
 * Postgres and asserts the resulting `CommissionAccrual.baseAmount` excludes the stamped NSF line.
 *
 * Follows the tenant-setup/cleanup pattern of `uncategorised-lines.nsf-2169.db.spec.ts` /
 * `import-commercial-columns.db.spec.ts`: a throwaway `qa-2169-<run>` tenant, `assertTestTenant`
 * first, child-first cleanup guarded behind a `tenantId` we actually set. `EntitlementsService`
 * and `AuditService` are stubbed ("everything permitted, no side channel") since this fixture's
 * concern is the real select/filter, not entitlement gating (proven elsewhere).
 */
import { randomUUID } from "crypto";
import { Test, TestingModule } from "@nestjs/testing";
import { CommissionEngineService } from "./commission-engine.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "#2169 CommissionEngineService — real-Postgres select proves the NSF line is excluded (SA-395)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let service: CommissionEngineService;
    let tenantId = "";
    const RUN = randomUUID().slice(0, 8);
    let invoiceId = "";
    let agentId = "";
    let customerId = "";

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const slug = assertTestTenant(`qa-2169-${RUN}`, "commission-engine.nsf-2169.db.spec.ts");
      tenantId = (await prisma.tenant.create({ data: { slug, name: `2169 ${slug}` } })).id;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CommissionEngineService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(true) },
          },
          { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        ],
      }).compile();
      service = module.get(CommissionEngineService);

      const user = await prisma.user.create({
        data: {
          email: `${tenantId}-cust@example.invalid`,
          username: `${tenantId}-cust`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: "Cust 2169", contactName: "Cust 2169", tenantId },
      });
      customerId = customer.id;

      const agent = await prisma.salesAgent.create({
        data: { name: "Agent 2169", status: "ACTIVE", tenantId },
      });
      agentId = agent.id;
      await prisma.agentAssignment.create({
        data: {
          tenantId,
          customerId,
          agentId,
          effectiveFrom: new Date("2026-01-01T00:00:00Z"),
          effectiveTo: null,
        },
      });
      await prisma.salesAgentRate.create({
        data: { tenantId, agentId, ratePct: 10, effectiveFrom: new Date("2026-01-01T00:00:00Z") },
      });

      // $1000 goods + a $25 NSF fee line STAMPED systemKind NSF_FEE with a NON-prefix description
      // (proves the read is driven by the real column, not the description prefix).
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId,
          invoiceNumber: `INV-2169-COMM-${RUN}`,
          status: "SENT",
          issueDate: new Date("2026-06-01T00:00:00Z"),
          dueDate: new Date("2026-07-01T00:00:00Z"),
          subtotal: 1025,
          total: 1025,
          items: {
            create: [
              {
                tenantId,
                description: "Bounce handling charge", // deliberately NOT the NSF prefix
                qty: 1,
                unitPrice: 25,
                subtotal: 25,
                productId: null,
                systemKind: "NSF_FEE" as never,
              },
              {
                tenantId,
                description: "Widget line",
                qty: 2,
                unitPrice: 10,
                subtotal: 20,
                productId: null,
              },
            ],
          },
          payments: {
            create: [{ tenantId, amount: 1025, method: "CASH", status: "PAID" }],
          },
        },
      });
      invoiceId = invoice.id;
    });

    afterAll(async () => {
      if (tenantId) {
        for (const del of [
          () => prisma.commissionAdjustment.deleteMany({ where: { tenantId } }),
          () => prisma.commissionAccrual.deleteMany({ where: { tenantId } }),
          () => prisma.invoicePayment.deleteMany({ where: { tenantId } }),
          () => prisma.invoiceItem.deleteMany({ where: { tenantId } }),
          () => prisma.invoice.deleteMany({ where: { tenantId } }),
          () => prisma.agentAssignment.deleteMany({ where: { tenantId } }),
          () => prisma.salesAgentRate.deleteMany({ where: { tenantId } }),
          () => prisma.salesAgent.deleteMany({ where: { tenantId } }),
          () => prisma.customer.deleteMany({ where: { tenantId } }),
          () => prisma.user.deleteMany({ where: { tenantId } }),
          () => prisma.tenant.delete({ where: { id: tenantId } }),
        ])
          await del().catch(() => undefined);
      }
      await prisma?.$disconnect();
    });

    it("real Postgres: syncInvoiceCommissionSafe's select reads systemKind and excludes the stamped NSF line from the base", async () => {
      await tenantCtx.run(tenantId, () => service.syncInvoiceCommissionSafe(invoiceId));
      const accrual = await prisma.commissionAccrual.findFirst({
        where: { tenantId, invoiceId, agentId },
      });
      expect(accrual).not.toBeNull();
      // base = subtotal(1025) - discount(0) - nsfFees(25) = 1000 — the stamped line never
      // inflates it, proving the real `systemKind: true` select column round-trips correctly.
      expect(Number(accrual!.baseAmount)).toBe(1000);
      expect(Number(accrual!.accruedAmount)).toBe(100);
    });
  },
);
