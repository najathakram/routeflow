/**
 * B646 / SA-135 — DB-lane proof on real Postgres. A recurring template line for a 12-pack at $40/box
 * with qty 2.5 (BOXES) generates an invoice line stored as boxes 2 / pieces 6 / qty 30 (pieces) /
 * unitsPerBox 12, subtotal = computeLineSubtotal at 12 ($100). Then ONE-READ consistency (SA-063):
 * the product is REPACKED to 6 for real, between the generator's pack read and create()'s own
 * product read, and the stored line still says 12 (the generator's pack rides along as packSnapshot).
 *
 * WHY THE DB LANE: the unit spec proves the builder with a hand-built product map; only a real DB
 * proves create()'s own product load, split and write, and a real repack between the two reads.
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`;
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * Harness: a real `InvoicesService` + real `RecurringInvoicesService` on a real `PrismaService`
 * (compose DB) + `TenantContextService`; every other collaborator mocked at the module boundary,
 * as in `invoices/recompute-order-partial.db.spec.ts`.
 *
 * SAFETY: every tenant is a throwaway `qa-b646-<run>-<n>` slug (`assertTestTenant`); `afterAll`
 * deletes exactly the rows this run created, per tenant id.
 */

jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { computeLineSubtotal } from "@routeflow/pricing";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { NotificationsService } from "../notifications/notifications.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string =>
  assertTestTenant(
    `qa-b646-${RUN_SUFFIX}-${++tenantSeq}-${label}`,
    "recurring-invoices.boxed-lines.db.spec.ts",
  );

describeDb("B646 — a boxed recurring template line is stored in pieces, real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoicesService: InvoicesService;
  let recurring: RecurringInvoicesService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        RecurringInvoicesService,
        EstimatesService,
        NumberingService,
        // InvoicesService now depends on the selling-restrictions choke point; this spec is about
        // boxed template quantities, so it allows every line.
        {
          provide: SellingRestrictionsService,
          useValue: {
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            // the unattended run (`generateInvoiceFromTemplate`) asks the non-throwing check
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
        { provide: NotificationsService, useValue: { sendToUser: jest.fn().mockResolvedValue(1) } },
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: tenantCtx },
        {
          provide: RouteFlowGateway,
          useValue: { emitInvoiceUpdated: jest.fn(), emitLowStock: jest.fn() },
        },
        {
          provide: EmailService,
          useValue: {
            sendInvoice: jest.fn().mockResolvedValue({ delivered: true }),
            isEmailConfigured: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
        },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            syncInvoiceEntries: jest.fn(),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: CreditNotesService,
          useValue: {
            autoApplyOldestCreditsInTx: jest
              .fn()
              .mockResolvedValue({ applied: 0, invoiceStatus: null }),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: MessagingService,
          useValue: { notify: jest.fn(), notifyEvent: jest.fn() },
        },
        { provide: StorageService, useValue: { upload: jest.fn(), delete: jest.fn() } },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn(),
            syncOrderInvoices: jest.fn(),
            removeInvoiceCommission: jest.fn(),
          },
        },
      ],
    }).compile();
    invoicesService = module.get(InvoicesService);
    recurring = module.get(RecurringInvoicesService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      for (const del of [
        () => prisma.invoiceItem.deleteMany({ where: { tenantId } }),
        () => prisma.stockMovement.deleteMany({ where: { tenantId } }),
        () => prisma.invoice.deleteMany({ where: { tenantId } }),
        // nextInvoiceNumber upserts a per-tenant sequence row (no FK): delete it too, or one leaks per run.
        () => prisma.numberingSequence.deleteMany({ where: { tenantId } }),
        () => prisma.recurringInvoiceItem.deleteMany({ where: { tenantId } }),
        () => prisma.recurringInvoice.deleteMany({ where: { tenantId } }),
        () => prisma.product.deleteMany({ where: { tenantId } }),
        () => prisma.customer.deleteMany({ where: { tenantId } }),
        () => prisma.user.deleteMany({ where: { tenantId } }),
        () => prisma.tenant.delete({ where: { id: tenantId } }),
      ]) {
        // Best-effort, FK order: a failed cleanup must never mask a test's own result, but it is
        // LOGGED (a swallowed tenant.delete failure would otherwise hide leaked rows).
        // eslint-disable-next-line no-await-in-loop
        await del().catch((e: unknown) =>
          console.warn(`B646 db spec cleanup (${tenantId}): ${e instanceof Error ? e.message : e}`),
        );
      }
    }
    await prisma?.$disconnect();
  });

  /** A test tenant with a 12-pack product at $40/box and a template line of 2.5 BOXES. */
  async function seed(label: string) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `B646 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `B646 ${slug}`,
        contactName: `B646 ${slug}`,
        tenantId: tenant.id,
      },
    });
    const product = await prisma.product.create({
      data: {
        name: `Case ${slug}`,
        unit: "case",
        pricePerUnit: 40,
        unitsPerBox: 12,
        tenantId: tenant.id,
      },
    });
    const ri = await prisma.recurringInvoice.create({
      data: {
        customerId: customer.id,
        frequency: "MONTHLY",
        dayOfMonth: 1,
        nextRunAt: new Date("2026-07-01T00:00:00Z"),
        tenantId: tenant.id,
        items: {
          create: [
            {
              description: "Case",
              productId: product.id,
              qty: 2.5,
              unitPrice: 40,
              tenantId: tenant.id,
            },
          ],
        },
      },
      include: { items: true },
    });
    return { tenant, product, ri };
  }

  const generate = (tenantId: string, ri: any) =>
    tenantCtx.run(tenantId, () => (recurring as any).generateInvoiceFromTemplate(ri));

  const storedLine = async (tenantId: string) =>
    (await prisma.invoiceItem.findMany({ where: { tenantId } }))[0];

  it("qty 2.5 of a 12-pack is stored as boxes 2 / pieces 6 / qty 30 / unitsPerBox 12, $100", async () => {
    const { tenant, ri } = await seed("split");
    await generate(tenant.id, ri);
    const line = await storedLine(tenant.id);
    expect(line).toBeDefined();
    expect(Number(line.boxes)).toBe(2);
    expect(Number(line.pieces)).toBe(6);
    expect(Number(line.qty)).toBe(30);
    expect(Number(line.unitsPerBox)).toBe(12);
    const expected = computeLineSubtotal({
      unitPrice: 40,
      qty: 30,
      boxes: 2,
      pieces: 6,
      unitsPerBox: 12,
    });
    expect(expected).toBe(100);
    expect(Number(line.subtotal)).toBe(expected);
  });

  it("a REAL repack to 6 between the generator's read and create()'s read still stores 12", async () => {
    const { tenant, product, ri } = await seed("repack");
    const realCreate = invoicesService.create.bind(invoicesService);
    const spy = jest.spyOn(invoicesService, "create").mockImplementationOnce(async (dto: any) => {
      // The generator has already read the pack (12) and split with it; repack NOW, for real,
      // so create()'s own product read sees 6.
      await prisma.product.update({ where: { id: product.id }, data: { unitsPerBox: 6 } });
      return realCreate(dto);
    });
    try {
      await generate(tenant.id, ri);
    } finally {
      spy.mockRestore();
    }
    const line = await storedLine(tenant.id);
    expect(
      Number((await prisma.product.findUnique({ where: { id: product.id } }))!.unitsPerBox),
    ).toBe(6);
    expect(Number(line.unitsPerBox)).toBe(12);
    expect(Number(line.boxes)).toBe(2);
    expect(Number(line.pieces)).toBe(6);
    expect(Number(line.qty)).toBe(30);
    expect(Number(line.subtotal)).toBe(100);
  });
});
