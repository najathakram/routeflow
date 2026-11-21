/**
 * SA-1148 case 1 (W-1205), DB lane: a buyer who pays one invoice from its own button must see THAT invoice paid.
 *
 * Observed on master `a1e5a564f9` (throwaway DB): two open invoices of 100, a CASH request carrying
 * `invoiceId` = the newer one, amount 100, approved -> the 100 landed on the OLDER invoice and the newer was
 * untouched, because every settle path allocated oldest first and nothing read the request's `invoiceId`.
 * This drives the REAL PaymentRequestsService + InvoicesService against Postgres so the ledger rows, not a
 * mock's arguments, prove where the money went. The harness (module wiring, seed) is shared in shape with
 * payment-requests.approve-idempotent.db.spec.ts.
 *
 * SAFETY: throwaway `qa-b8probe-<run>-<n>-<label>` tenants only (`assertTestTenant`); `afterAll`
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
import { ConnectChargeReviewService } from "./connect-charge-review.service";
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
    `qa-b8probe-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "payment-requests.chosen-invoice.db.spec.ts",
  );
}

describeDb("SA-1148 the chosen invoice is paid first (cash approve) — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: PaymentRequestsService;
  const createdTenantIds: string[] = [];
  /** When true, the next in-transaction `buyerPaymentRequest.updateMany` (the claim) throws. */
  let failNextClaim = false;
  /** W-769 W6: the captured settle's after-commit operator alert (SA-862), a spy. */
  const chargeReview = {
    flagDuplicateSuspect: jest.fn(),
    flagUnconfirmedOverReserved: jest.fn(async () => undefined),
  };

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    // The services see prisma through a thin proxy: ONLY the claim inside the money transaction can
    // fail (after the payment rows are written), everything else is the real client.
    const failingClaimPrisma = new Proxy(prisma, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== "tenantTransaction") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (fn: (tx: any) => Promise<unknown>, options?: any) =>
          target.tenantTransaction(
            (tx: any) =>
              fn(
                new Proxy(tx, {
                  get(txTarget, txProp) {
                    const model = Reflect.get(txTarget, txProp, txTarget);
                    if (txProp !== "buyerPaymentRequest") {
                      return typeof model === "function" ? model.bind(txTarget) : model;
                    }
                    return new Proxy(model, {
                      get(m, method) {
                        const fnc = Reflect.get(m, method, m);
                        if (method !== "updateMany") {
                          return typeof fnc === "function" ? fnc.bind(m) : fnc;
                        }
                        return (args: any) => {
                          if (failNextClaim) {
                            failNextClaim = false;
                            return Promise.reject(new Error("simulated claim/link failure"));
                          }
                          return fnc.call(m, args);
                        };
                      },
                    });
                  },
                }),
              ),
            options,
          );
      },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        PaymentRequestsService,
        // SA-837b: the Stripe settle path alerts operators of a duplicate-suspect capture; not exercised here.
        { provide: ConnectChargeReviewService, useValue: chargeReview },
        NumberingService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: failingClaimPrisma },
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
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
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
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        // W-769 W6: the settle's anti-spoof account check passes for the fixture
        { provide: StripeConnectService, useValue: { assertEventAccount: async () => true } },
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
    await prisma.auditLog.deleteMany({ where: { tenantId } }); // W-769: the over-reserved rows
    await prisma.advancePayment.deleteMany({ where: { tenantId } });
    await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderReviewFlag.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.paymentCounter.deleteMany({ where: { id: tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seed(label: string, opts: { invoiceTotal?: number } = {}) {
    const slug = freshTenantSlug(label);
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
    const invoice = opts.invoiceTotal
      ? await prisma.invoice.create({
          data: {
            tenantId: tenant.id,
            customerId: customer.id,
            invoiceNumber: `INV-SEED-${randomUUID().slice(0, 8)}`,
            status: "SENT",
            subtotal: opts.invoiceTotal,
            total: opts.invoiceTotal,
          },
        })
      : null;
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
    const approve = () =>
      tenantCtx.run(tenant.id, () =>
        service.approve(request.id, { id: user.id, username: "operator" }),
      );
    const state = async () => {
      const payments = await prisma.invoicePayment.findMany({
        where: { invoice: { customerId: customer.id } },
      });
      const advances = await prisma.advancePayment.findMany({
        where: { customerId: customer.id },
      });
      const req = await prisma.buyerPaymentRequest.findUnique({ where: { id: request.id } });
      return {
        payments,
        advances,
        status: req?.status,
        paymentGroupId: req?.paymentGroupId ?? null,
        credited:
          payments.reduce((sum, p) => sum + Number(p.amount), 0) +
          advances.reduce((sum, a) => sum + Number(a.amount), 0),
      };
    };
    return { approve, state, tenant, invoice, requestId: request.id };
  }

  it("case 1: two open invoices, the buyer pays the NEWER one from its own button (request.invoiceId = newer, amount = its balance): newer is paid, older untouched", async () => {
    const {
      tenant,
      invoice: older,
      requestId,
      approve,
      state,
    } = await seed("p1", { invoiceTotal: 100 });
    const customerId = older!.customerId;
    await prisma.invoice.update({
      where: { id: older!.id },
      data: { issueDate: new Date("2026-01-01") },
    });
    const newer = await prisma.invoice.create({
      data: {
        tenantId: tenant.id,
        customerId,
        invoiceNumber: "INV-SEED-NEWER-" + randomUUID().slice(0, 6),
        status: "SENT",
        subtotal: 100,
        total: 100,
        issueDate: new Date("2026-02-01"),
      },
    });
    await prisma.buyerPaymentRequest.update({
      where: { id: requestId },
      data: { amount: 100, invoiceId: newer.id },
    });
    await approve();
    const rows = await prisma.invoicePayment.findMany({ where: { invoice: { customerId } } });
    const out = rows.map((r) => ({
      which: r.invoiceId === newer.id ? "NEWER" : "OLDER",
      amount: Number(r.amount),
    }));
    expect(out).toEqual([{ which: "NEWER", amount: 100 }]);
    const s = await state();
    expect(s.status).toBe("APPROVED");
    expect(s.credited).toBe(100);
    expect(s.advances).toHaveLength(0); // excess 0: nothing went to on-account credit
  });
});
