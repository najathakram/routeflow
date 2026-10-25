/**
 * DB twin for row 615 / SA-818 — approving a declared cash payment claims the request, writes the
 * money and links `paymentGroupId` in ONE transaction, so it can never credit twice.
 *
 * WHY THE DB LANE: the defect is a transaction/race shape. On master the money committed in
 * `recordStandalonePayment`'s own transaction, the request was claimed before it and linked after
 * it, and a failure of the link reopened the request to PENDING so the next Approve recorded again
 * (300 became 600). Mocks cannot show that the ledger holds one credit; this drives the REAL
 * PaymentRequestsService + InvoicesService against Postgres. Failure injection: the request's
 * compare-and-set (`tx.buyerPaymentRequest.updateMany`, run by the `inTx` hook inside the money
 * transaction) throws once.
 *
 *  - T1 (MUST a, d): a throw from the claim/link rolls the money back (no InvoicePayment, request
 *    still PENDING), and a retry credits exactly once with the buyer's reference unchanged.
 *  - T2 (MUST b): two concurrent approvals of the same request credit exactly once.
 *  - T3 (MUST c): an all-excess approval (no open invoices) claims in the same transaction as the
 *    AdvancePayment; a throw leaves neither.
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
    `qa-b615-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "payment-requests.approve-idempotent.db.spec.ts",
  );
}

describeDb(
  "row 615 cash approval claims and links inside the money transaction — real Postgres",
  () => {
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
              settleRegulatedLedger: jest
                .fn()
                .mockResolvedValue({ written: 0, amendedPeriod: null }),
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

    it("T1 a throw from the claim/link rolls the money back and leaves the request PENDING; the retry credits once (300, not 600) with the buyer's reference unchanged", async () => {
      const { approve, state } = await seed("t1", { invoiceTotal: 1000 });

      failNextClaim = true;
      await expect(approve()).rejects.toThrow("simulated claim/link failure");
      const afterFailure = await state();
      expect({
        status: afterFailure.status,
        credited: afterFailure.credited,
        rows: afterFailure.payments.length,
        advances: afterFailure.advances.length,
      }).toEqual({ status: "PENDING", credited: 0, rows: 0, advances: 0 });

      await approve();
      const afterRetry = await state();
      expect({ status: afterRetry.status, credited: afterRetry.credited }).toEqual({
        status: "APPROVED",
        credited: 300,
      });
      // The link names the very payment group that holds the money; the reference is as entered.
      expect(afterRetry.paymentGroupId).not.toBeNull();
      expect(afterRetry.payments).toHaveLength(1);
      expect(afterRetry.payments[0].paymentGroupId).toBe(afterRetry.paymentGroupId);
      expect(afterRetry.payments[0].reference).toBe("receipt 7");
    }, 60_000);

    it("T2 two concurrent approvals of the same request credit exactly once; the loser is told it was already decided", async () => {
      const { approve, state } = await seed("t2", { invoiceTotal: 1000 });

      const settled = await Promise.allSettled([approve(), approve()]);

      const fulfilled = settled.filter((r) => r.status === "fulfilled");
      const rejected = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0].reason?.message ?? rejected[0].reason)).toContain(
        "Request already decided",
      );
      const after = await state();
      expect({
        status: after.status,
        credited: after.credited,
        rows: after.payments.length,
      }).toEqual({ status: "APPROVED", credited: 300, rows: 1 });
    }, 60_000);

    it("T3 an all-excess approval (no open invoices) claims the request in the same transaction as the AdvancePayment", async () => {
      const { approve, state } = await seed("t3");

      failNextClaim = true;
      await expect(approve()).rejects.toThrow("simulated claim/link failure");
      const afterFailure = await state();
      // A throw in the hook leaves neither the advance nor an APPROVED request.
      expect({
        status: afterFailure.status,
        advances: afterFailure.advances.length,
        credited: afterFailure.credited,
      }).toEqual({ status: "PENDING", advances: 0, credited: 0 });

      await approve();
      const afterRetry = await state();
      expect({
        status: afterRetry.status,
        advances: afterRetry.advances.length,
        credited: afterRetry.credited,
      }).toEqual({ status: "APPROVED", advances: 1, credited: 300 });
      expect(afterRetry.paymentGroupId).not.toBeNull();
      expect(afterRetry.advances[0].reference).toBe("receipt 7");
    }, 60_000);

    // W-769 W8 (owner 7b = A, SA-910 Part 2): the buyer's cash approval is real money. Over an invoice a DRAFT reserves, it
    // records and flags the DRAFT with ONE over-reserved audit row (master: records, no audit row).
    it("W8 a $300 cash approval over a DRAFT 300 on a $300 invoice: PAID 300 recorded, the DRAFT kept and flagged once", async () => {
      const s = await seed("w769-w8", { invoiceTotal: 300 });
      const d = await prisma.invoicePayment.create({
        data: {
          invoiceId: s.invoice!.id,
          tenantId: s.tenant.id,
          amount: 300,
          method: "CASH",
          status: "DRAFT",
        } as any,
      });
      await s.approve();
      const rows = await prisma.invoicePayment.findMany({
        where: { invoiceId: s.invoice!.id },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.map((r) => `${r.status} ${Number(r.amount)}`)).toEqual(["DRAFT 300", "PAID 300"]);
      const flagged = await prisma.auditLog.findMany({
        where: { tenantId: s.tenant.id, action: "payment.unconfirmed-over-reserved" },
      });
      expect(flagged).toHaveLength(1);
      expect(flagged[0].meta).toMatchObject({ displaced: [d.id] });
    }, 60_000);

    // W-769 W6 (SA-862 rule 1): a Stripe-captured settle is never refused. Over an invoice a DRAFT reserves, the card money
    // lands on the invoice, the DRAFT is flagged with ONE over-reserved audit row, and the operator alert fires after commit.
    // Master: the confirmed-basis allocation records with no audit row and no alert.
    it("W6 a $300 card settle over a DRAFT 300 on a $300 invoice: PAID 300 on the invoice, the DRAFT flagged once, the alert raised", async () => {
      const s = await seed("w769-w6", { invoiceTotal: 300 });
      const d = await prisma.invoicePayment.create({
        data: {
          invoiceId: s.invoice!.id,
          tenantId: s.tenant.id,
          amount: 300,
          method: "CASH",
          status: "DRAFT",
        } as any,
      });
      const pi = `pi_w769_${randomUUID().slice(0, 8)}`;
      chargeReview.flagUnconfirmedOverReserved.mockClear();
      await expect(
        service.settleByPaymentIntent({
          type: "payment_intent.succeeded",
          eventId: `evt_${pi}`,
          accountRef: "acct_w769",
          created: new Date(),
          paymentIntentId: pi,
          amountDollars: 300,
          currency: "usd",
          methodKind: "card",
          metadata: { tenantId: s.tenant.id, buyerPaymentRequestId: s.requestId },
        }),
      ).resolves.toEqual({ handled: true });
      const rows = await prisma.invoicePayment.findMany({
        where: { invoiceId: s.invoice!.id },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.map((r) => `${r.status} ${Number(r.amount)}`)).toEqual(["DRAFT 300", "PAID 300"]);
      const flagged = await prisma.auditLog.findMany({
        where: { tenantId: s.tenant.id, action: "payment.unconfirmed-over-reserved" },
      });
      expect(flagged).toHaveLength(1);
      expect(flagged[0].meta).toMatchObject({ displaced: [d.id] });
      expect(chargeReview.flagUnconfirmedOverReserved).toHaveBeenCalledTimes(1);
    }, 60_000);
  },
);
