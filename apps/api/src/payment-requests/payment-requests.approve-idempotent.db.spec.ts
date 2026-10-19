/**
 * DB twin for row 615 — a cash-payment approval whose money write COMMITS but whose
 * `paymentGroupId` link write then FAILS must never credit the customer twice.
 *
 * WHY THE DB LANE: the defect is the committed-then-link-fails shape — a real
 * `recordStandalonePayment` transaction that has committed independently of the request row's
 * follow-up update. Mocks cannot show that the ledger really holds one payment after a second
 * Approve; this drives the REAL PaymentRequestsService + InvoicesService against Postgres, with
 * only the request's link write (`buyerPaymentRequest.update` carrying `paymentGroupId`)
 * failing once.
 *
 * Wrong value on the unfixed code: the failed link write reopens the request to PENDING, the
 * second Approve records again, and the customer's credited total is 600 instead of 300.
 *
 * SAFETY: throwaway `qa-b615-<run>-<n>-<label>` tenants only (`assertTestTenant`); `afterAll`
 * deletes exactly what this run created.
 */

jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { PaymentRequestsService } from "./payment-requests.service";
import { PAYMENT_PROVIDER } from "./provider/payment-provider.interface";
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
import { NumberingService } from "../import/numbering.service";
import { StripeConnectService } from "../stripe-connect/stripe-connect.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b615-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "payment-requests.approve-idempotent.db.spec.ts",
  );
}

describeDb("row 615 cash approval is idempotent — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: PaymentRequestsService;
  const createdTenantIds: string[] = [];
  /** When true, the next `buyerPaymentRequest.update` that writes `paymentGroupId` throws. */
  let failNextLinkWrite = false;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    // The service sees prisma through a thin proxy so ONLY the request's link write can fail;
    // the money transaction inside InvoicesService uses the real client and commits.
    const failingLinkPrisma = new Proxy(prisma, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === "buyerPaymentRequest") {
          return new Proxy(value, {
            get(model, m) {
              const fn = Reflect.get(model, m, model);
              if (m !== "update") return typeof fn === "function" ? fn.bind(model) : fn;
              return (args: any) => {
                if (failNextLinkWrite && args?.data && "paymentGroupId" in args.data) {
                  failNextLinkWrite = false;
                  return Promise.reject(new Error("simulated link write failure"));
                }
                return fn.call(model, args);
              };
            },
          });
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        PaymentRequestsService,
        NumberingService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: failingLinkPrisma },
        { provide: TenantContextService, useValue: tenantCtx },
        {
          provide: RouteFlowGateway,
          useValue: { emitInvoiceUpdated: jest.fn(), emitBuyerPaymentRequest: jest.fn() },
        },
        {
          provide: EmailService,
          useValue: { sendInvoice: jest.fn(), isEmailConfigured: jest.fn() },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
        },
        {
          provide: RegulatedLedgerService,
          useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
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
          useValue: {
            notify: jest.fn().mockResolvedValue([]),
            notifyEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: StorageService, useValue: {} },
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
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: StripeConnectService, useValue: {} },
        { provide: PAYMENT_PROVIDER, useValue: {} },
      ],
    }).compile();

    service = module.get(PaymentRequestsService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.buyerPaymentRequest.deleteMany({ where: { tenantId } });
    await prisma.advancePayment.deleteMany({ where: { tenantId } });
    await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.paymentCounter.deleteMany({ where: { id: tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  it("T1 a cash approval whose link write fails after the payment committed stays APPROVED, and a second Approve credits nothing more (total 300, not 600)", async () => {
    const slug = freshTenantSlug("t1");
    const tenant = await prisma.tenant.create({ data: { slug, name: `B615 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${tenant.id}@example.invalid`,
        username: tenant.id,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "B615 customer",
        contactName: "B615 contact",
        tenantId: tenant.id,
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        invoiceNumber: `INV-SEED-${randomUUID().slice(0, 8)}`,
        status: "SENT",
        subtotal: 1000,
        total: 1000,
      },
    });
    const request = await prisma.buyerPaymentRequest.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        kind: "CASH",
        status: "PENDING",
        amount: 300,
        reference: "receipt 7",
      },
    });
    const operator = { id: user.id, username: "operator" };

    const credited = async () => {
      const payments = await prisma.invoicePayment.findMany({ where: { invoiceId: invoice.id } });
      const advances = await prisma.advancePayment.findMany({
        where: { customerId: customer.id },
      });
      return (
        payments.reduce((s, p) => s + Number(p.amount), 0) +
        advances.reduce((s, a) => s + Number(a.amount), 0)
      );
    };

    failNextLinkWrite = true;
    await tenantCtx
      .run(tenant.id, () => service.approve(request.id, operator))
      .catch(() => undefined);
    const afterFirst = await prisma.buyerPaymentRequest.findUnique({ where: { id: request.id } });

    await tenantCtx
      .run(tenant.id, () => service.approve(request.id, operator))
      .catch(() => undefined);

    expect({ status: afterFirst?.status, credited: await credited() }).toEqual({
      status: "APPROVED",
      credited: 300,
    });
    // The second Approve healed the link instead of recording again.
    const healed = await prisma.buyerPaymentRequest.findUnique({ where: { id: request.id } });
    expect(healed?.paymentGroupId).not.toBeNull();
  }, 60_000);
});
