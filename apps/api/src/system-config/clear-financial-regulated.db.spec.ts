/**
 * Row 683 R11 (SA-896, ruling (b)): `DELETE /settings/financial-data` deletes every invoice, payment and the rest in one raw
 * transaction, but never the compliance records: `RegulatedSalesLedger` has no FK to the invoice, and `TobaccoReport` /
 * `RegulatedFiling` stay. A wipe therefore left the ledger counting sales whose source documents are gone. The wipe is now
 * REFUSED (409 FINANCIAL_WIPE_BLOCKED_REGULATED) while the tenant holds ANY ledger row, tobacco report or regulated filing,
 * and nothing is deleted. A tenant with none of them wipes exactly as before.
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-683w-<run>-<n>` slug (`assertTestTenant`).
 */
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EmailService } from "../email/email.service";
import { quickKeysSettingsStubProvider } from "../testing/quick-keys-settings-stub";
import { FINANCIAL_WIPE_BLOCKED_REGULATED_MESSAGE } from "./financial-wipe-guard";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("clearFinancialData refuses while regulated records exist (683 R11, SA-896)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let controller: SettingsController;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const mod = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            getAll: jest.fn().mockResolvedValue({}),
          },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
        quickKeysSettingsStubProvider,
      ],
    }).compile();
    controller = mod.get(SettingsController);
  });

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
      await prisma.tobaccoReport.deleteMany(where).catch(swallow);
      await prisma.regulatedFiling.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } }).catch(swallow);
      await prisma.invoiceItem.deleteMany({ where: { invoice: { tenantId } } }).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.trackedCategory.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /** A tenant with one customer, one invoice + item; `regulated` adds the one record of that kind. */
  async function seed(label: string, regulated: "ledger" | "tobacco" | "filing" | null) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-683w-${RUN}-${seq}-${label}`,
      "clear-financial-regulated.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `683w ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        invoiceNumber: `INV-683w-${RUN}-${seq}`,
        status: "SENT",
        subtotal: 75,
        taxAmount: 0,
        total: 75,
      },
    });
    const item = await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        description: "goods",
        qty: 75,
        unitPrice: 1,
        subtotal: 75,
      },
    });
    const start = new Date(Date.UTC(2026, 8, 1));
    const endExcl = new Date(Date.UTC(2026, 9, 1));
    if (regulated === "ledger" || regulated === "filing") {
      const cat = await prisma.trackedCategory.create({
        data: { tenantId, name: `Tobacco ${label}`, taxType: "NONE" },
      });
      if (regulated === "ledger") {
        await prisma.regulatedSalesLedger.create({
          data: {
            tenantId,
            trackedCategoryId: cat.id,
            entryType: "SALE",
            invoiceId: invoice.id,
            invoiceItemId: item.id,
            qty: 75,
            unitBasisQty: 75,
            netSales: 75,
            soldAt: new Date(Date.UTC(2026, 8, 15)),
            periodBucket: "2026-09",
          },
        });
      } else {
        await prisma.regulatedFiling.create({
          data: {
            tenantId,
            trackedCategoryId: cat.id,
            reportTemplate: "GENERIC",
            periodKey: "2026-09",
            periodStart: start,
            periodEnd: endExcl,
            status: "GENERATED",
            rows: [],
          } as any,
        });
      }
    }
    if (regulated === "tobacco") {
      await prisma.tobaccoReport.create({
        data: {
          tenantId,
          periodYear: 2026,
          periodMonth: 9,
          periodStart: start,
          periodEnd: new Date(endExcl.getTime() - 1),
          status: "GENERATED",
          rows: [],
        } as any,
      });
    }
    return { tenantId, invoiceId: invoice.id };
  }

  const wipe = (tenantId: string) =>
    tenantCtx.run(tenantId, () =>
      controller.clearFinancialData({ confirmTenantId: tenantId } as any),
    );
  const invoicesOf = (tenantId: string) => prisma.invoice.count({ where: { tenantId } });

  it.each([
    ["one regulated-ledger row", "ledger" as const],
    ["one tobacco report", "tobacco" as const],
    ["one regulated filing", "filing" as const],
  ])(
    "R11: a tenant with %s: 409 FINANCIAL_WIPE_BLOCKED_REGULATED and NOTHING deleted (head: 200)",
    async (_n, kind) => {
      const s = await seed(kind, kind);
      const err: any = await wipe(s.tenantId).catch((e) => e);
      expect(err?.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        code: "FINANCIAL_WIPE_BLOCKED_REGULATED",
        message: FINANCIAL_WIPE_BLOCKED_REGULATED_MESSAGE, // #3682 NIT-4
      });
      expect(await invoicesOf(s.tenantId)).toBe(1);
      expect(await prisma.invoiceItem.count({ where: { invoiceId: s.invoiceId } })).toBe(1);
      if (kind === "ledger") {
        expect(await prisma.regulatedSalesLedger.count({ where: { tenantId: s.tenantId } })).toBe(
          1,
        );
      }
    },
    60_000,
  );

  it("R11 guard: a tenant with no regulated records still wipes (the same delete set as today)", async () => {
    const s = await seed("plain", null);
    await wipe(s.tenantId);
    expect(await invoicesOf(s.tenantId)).toBe(0);
  }, 60_000);
});
