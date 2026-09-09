/**
 * TP-DB / T2 — DB-lane repro for REG-B269 (payment numbering, site 3 —
 * `InvoicesService.recordStandalonePayment`, reached from the Stripe settlement path at
 * `payment-requests.service.ts:853`). Design of record:
 * `.claude/pipeline/2026-09-08-numbering-siblings/cause-ruling.md` §2 (D3). Binding facts:
 * `cause-refutation.md` §2.3 (the live cross-tenant collision + the aggravating settlement-stall
 * path), §4 (InvoicePayment.paymentNumber is GLOBALLY unique — the only non-PK unique on the
 * model), §5 (all three PAY sites run inside `tenantTransaction`, never standalone).
 *
 * WHY THE DB LANE (L-061): the cross-tenant collision on a GLOBAL unique (`P2002`) and a real
 * transaction rollback leaving the counter untouched are only provable against a REAL Postgres —
 * a mocked `prisma.invoicePayment.create` can't reproduce a genuine unique-constraint violation
 * across two independent tenant counters, or a real `$transaction` rollback.
 *
 * This spec drives the REAL, public `InvoicesService.recordPayment()` (site 1) and
 * `recordStandalonePayment()` (site 3 — cause-refutation.md §2.3's aggravating settlement path
 * reaches this SAME method; `payment-requests.service.ts` itself is out of scope for this
 * package's file list and is not driven directly here) through a NestJS TestingModule wired with
 * a REAL `PrismaService` and a REAL `TenantContextService`, mirroring
 * `invoice-numbering.db.spec.ts`'s provider set for `InvoicesService` (every OTHER collaborator
 * mocked at the module boundary; `NumberingService` is real but unused by either PAY site —
 * cause-ruling.md D3 explicitly keeps PAYMENT off `reserveNext`).
 *
 * SAFETY: every tenant this file creates is a throwaway `qa-b269-<run>-<n>-<label>` slug, approved
 * by `assertTestTenant`. `afterAll` deletes exactly the tenants THIS run created (FK order:
 * AdvancePayment → InvoicePayment → Invoice → PaymentCounter(by tenant id) → Customer → User →
 * Tenant). T2c's "singleton" `PaymentCounter` row is SHARED, global state this file does not own
 * (other tests/consumers may write it) — its test asserts a before/after DELTA rather than an
 * absolute value and never deletes the row.
 *
 * SELF-CONTAINED ORACLES: every test seeds every row its own expectation depends on. T2c is the
 * one qualified case — it is RED either way, but WHICH of the two documented wrong values it
 * surfaces (a bare `PAY-####` mint vs. a P2002 on it) depends on whether a sibling already holds
 * `PAY-0001` in the shared GLOBAL `paymentNumber` namespace, which is the very collision B269 is
 * about.
 *
 * RED-GATE FILE: every test here must FAIL on today's code on its own predicted wrong value. The
 * plan's GREEN pin for this area (T2d PIN-B269-D, sites 1/2's unchanged format) therefore lives in
 * the sibling `payment-numbering-pins.db.spec.ts`, not in this file.
 */

// Prevent Jest from traversing ESM-only dependencies (same guard as invoices.service.spec.ts /
// invoice-numbering.db.spec.ts — InvoicesService imports these).
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
/** A fresh, policy-approved throwaway tenant slug — never reused across tests in this file. */
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b269-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "payment-numbering.db.spec.ts",
  );
}

/** Matches sites 1/2's `counterKey.slice(0, 6).toUpperCase()` exactly. */
function tenantShort(tenantId: string): string {
  return tenantId.slice(0, 6).toUpperCase();
}

describeDb(
  "B269 payment numbering — real Postgres (T2: tenancy, rollback, null-tenant refusal)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoicesService: InvoicesService;
    const createdTenantIds: string[] = [];

    const mockGateway = {
      emitInvoiceUpdated: jest.fn(),
      emitOrderCreated: jest.fn(),
      emitOrderStatusChanged: jest.fn(),
      emitLowStock: jest.fn(),
      emitStopCompleted: jest.fn(),
      emitUrgentOrder: jest.fn(),
    };
    const mockEmailService = {
      sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
      isEmailConfigured: jest.fn().mockResolvedValue(true),
    };
    const mockSystemConfig = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const mockCreditNotes = {
      autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
      settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
      releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
    };
    const mockMessaging = {
      notify: jest.fn().mockResolvedValue([]),
      notifyEvent: jest.fn().mockResolvedValue(undefined),
    };
    const mockStorage = {
      upload: jest.fn().mockResolvedValue("stored"),
      presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
    const mockCommissionEngine = {
      syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
      syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
      removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
    };

    beforeAll(async () => {
      // Nothing env-dependent may run at collection time (db-lane.db.spec.ts's rule): the real
      // connection is built here, inside a hook, never at module top level.
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          InvoicesService,
          NumberingService,
          { provide: PrismaService, useValue: prisma },
          { provide: RouteFlowGateway, useValue: mockGateway },
          { provide: EmailService, useValue: mockEmailService },
          { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
          { provide: SystemConfigService, useValue: mockSystemConfig },
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
          { provide: CreditNotesService, useValue: mockCreditNotes },
          { provide: MessagingService, useValue: mockMessaging },
          { provide: StorageService, useValue: mockStorage },
          { provide: EntitlementsService, useValue: mockEntitlements },
          { provide: CommissionEngineService, useValue: mockCommissionEngine },
        ],
      }).compile();

      invoicesService = module.get(InvoicesService);
    });

    afterAll(async () => {
      for (const tenantId of createdTenantIds) {
        // eslint-disable-next-line no-await-in-loop
        await cleanupTenant(tenantId).catch(() => {
          // Best-effort: a failed cleanup must never mask the test's own pass/fail result.
        });
      }
      await prisma?.$disconnect();
    });

    async function cleanupTenant(tenantId: string): Promise<void> {
      await prisma.advancePayment.deleteMany({ where: { tenantId } });
      await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
      await prisma.invoice.deleteMany({ where: { tenantId } });
      // Sites 1/3 key their counter row by the ambient tenantId (never "singleton" once a
      // context exists) — id equals the tenant id we created.
      await prisma.paymentCounter.deleteMany({ where: { id: tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }

    async function seedTenant(label: string): Promise<{ id: string; slug: string }> {
      const slug = freshTenantSlug(label);
      const tenant = await prisma.tenant.create({ data: { slug, name: `B269 ${slug}` } });
      createdTenantIds.push(tenant.id);
      return { id: tenant.id, slug };
    }

    async function seedCustomer(tenantId: string, label: string): Promise<{ id: string }> {
      const idBase = `${tenantId}-${label}`;
      const user = await prisma.user.create({
        data: {
          email: `${idBase}@example.invalid`,
          username: idBase,
          role: "CUSTOMER",
          tenantId,
        },
      });
      const customer = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: `B269 customer ${label}`,
          contactName: `B269 contact ${label}`,
          tenantId,
        },
      });
      return { id: customer.id };
    }

    async function seedInvoice(tenantId: string, customerId: string, total: number) {
      return prisma.invoice.create({
        data: {
          tenantId,
          customerId,
          invoiceNumber: `INV-SEED-${randomUUID().slice(0, 8)}`,
          status: "SENT",
          subtotal: total,
          total,
        },
      });
    }

    it("T2a REG-B269-A two tenants' first settlements are distinct: through the site-3 path (recordStandalonePayment), tenant A and tenant B each book their first payment — expect PAY-<A>-0001 and PAY-<B>-0001. TODAY: both mint plain PAY-0001 (no tenantShort segment) and the second collides on the GLOBAL paymentNumber unique", async () => {
      const tenantA = await seedTenant("t2a-a");
      const custA = await seedCustomer(tenantA.id, "a");
      const invoiceA = await seedInvoice(tenantA.id, custA.id, 100);

      const tenantB = await seedTenant("t2a-b");
      const custB = await seedCustomer(tenantB.id, "b");
      const invoiceB = await seedInvoice(tenantB.id, custB.id, 100);

      let numberA: string;
      try {
        const resultA = await tenantCtx.run(tenantA.id, () =>
          invoicesService.recordStandalonePayment({
            customerId: custA.id,
            totalAmount: 5,
            method: "CASH",
            allocations: [{ invoiceId: invoiceA.id, amount: 5 }],
          } as any),
        );
        numberA = resultA.payments[0].paymentNumber;
      } catch (err: any) {
        numberA = `<threw ${err?.constructor?.name}>`;
      }

      let numberB: string;
      try {
        const resultB = await tenantCtx.run(tenantB.id, () =>
          invoicesService.recordStandalonePayment({
            customerId: custB.id,
            totalAmount: 5,
            method: "CASH",
            allocations: [{ invoiceId: invoiceB.id, amount: 5 }],
          } as any),
        );
        numberB = resultB.payments[0].paymentNumber;
      } catch (err: any) {
        numberB = `<threw ${err?.constructor?.name}>`;
      }

      expect({ numberA, numberB }).toEqual({
        numberA: `PAY-${tenantShort(tenantA.id)}-0001`,
        numberB: `PAY-${tenantShort(tenantB.id)}-0001`,
      });
    }, 30_000);

    it("T2b REG-B269-B a rolled-back booking does not repeat the number: a 2-allocation booking whose FIRST allocation targets a nonexistent invoice reserves from the tenant's PaymentCounter and then rolls back entirely on the resulting NotFoundException — the reservation must survive that rollback (a PaymentCounter(tenantA) row exists with next advanced past its initial 1, a burnt gap rather than a repeat; the oracle deliberately does NOT pin the block size, so a per-booking OR a per-allocation reservation granularity both satisfy it — cause-ruling D3 fixes the reservation's LIFETIME, not its width). TODAY: the counter increment lives INSIDE the same rolled-back tx, so no PaymentCounter row for this tenant exists at all after the failure — a retry would mint the SAME number again, which is the permanent Stripe-webhook stall cause-refutation.md §2.3 describes. (The oracle is asserted BOTH ways: on the number a following live booking mints — the behavioural half, asserted first because it is what a partial fix could slip past — and on the counter row read before that booking, which stays independent of the shared GLOBAL paymentNumber namespace every other test in this file also writes into.)", async () => {
      const tenantA = await seedTenant("t2b-a");
      const custA = await seedCustomer(tenantA.id, "a");
      const invoiceA = await seedInvoice(tenantA.id, custA.id, 100);
      const bogusInvoiceId = randomUUID();

      let firstError: any;
      try {
        await tenantCtx.run(tenantA.id, () =>
          invoicesService.recordStandalonePayment({
            customerId: custA.id,
            totalAmount: 10,
            method: "CASH",
            // Bogus allocation FIRST: the invoice-lookup guard throws before any
            // invoicePayment.create() runs, so this failure is never entangled with the
            // GLOBAL paymentNumber unique other tests in this file also write into.
            allocations: [
              { invoiceId: bogusInvoiceId, amount: 5 },
              { invoiceId: invoiceA.id, amount: 5 },
            ],
          } as any),
        );
      } catch (err) {
        firstError = err;
      }
      expect(firstError).toBeInstanceOf(NotFoundException);

      // Nothing from the failed attempt should have been written — the whole tx rolled back.
      const paymentsAfterFailure = await prisma.invoicePayment.count({
        where: { invoiceId: invoiceA.id },
      });
      expect(paymentsAfterFailure).toBe(0);

      // Read (do not yet assert) the counter, BEFORE the retry booking below
      // advances it further.
      const counterAfterFailure = await prisma.paymentCounter.findUnique({
        where: { id: tenantA.id },
      });

      // THE BEHAVIOURAL ORACLE, asserted FIRST so it is the assertion that
      // actually fails today: the reservation-lifetime property proved on a
      // MINTED VALUE rather than on where the counter happens to be stored. The
      // next valid booking through this same site must not re-issue the number
      // the rolled-back booking already took. Deliberately granularity-agnostic
      // (D3 fixes the reservation's LIFETIME, not its block size), and the
      // tenant-scoped SHAPE is red today all by itself — site 3 mints a bare
      // `PAY-####` with no tenant segment.
      const retry = await tenantCtx.run(tenantA.id, () =>
        invoicesService.recordStandalonePayment({
          customerId: custA.id,
          totalAmount: 5,
          method: "CASH",
          allocations: [{ invoiceId: invoiceA.id, amount: 5 }],
        } as any),
      );
      const retryNumber = retry.payments[0].paymentNumber;
      expect(retryNumber).toMatch(new RegExp(`^PAY-${tenantShort(tenantA.id)}-\\d{4}$`));
      expect(retryNumber).not.toBe(`PAY-${tenantShort(tenantA.id)}-0001`);

      // THE STRUCTURAL HALF: did the counter reservation survive the booking
      // tx's own rollback? Today no PaymentCounter row for this tenant exists at
      // all after the failure.
      expect(counterAfterFailure).not.toBeNull();
      // Granularity-agnostic on purpose: any advance past the initial 1 proves
      // the number was burnt rather than re-issued.
      expect(counterAfterFailure?.next ?? 1).toBeGreaterThan(1);
    }, 30_000);

    it("T2c REG-B269-C null tenant refuses: recordStandalonePayment with NO ambient tenant context must refuse (BadRequestException) and write no 'singleton' PaymentCounter row. TODAY: it falls back to the shared 'singleton' counter and mints a BARE PAY-#### with no tenant segment — which, once a sibling booking already holds that number in the GLOBAL paymentNumber namespace, surfaces as a P2002 (PrismaClientKnownRequestError) instead of a mint. Both received values are the same defect (no tenant in the number); neither is BadRequestException", async () => {
      const tenantA = await seedTenant("t2c-a");
      const custA = await seedCustomer(tenantA.id, "a");
      const invoiceA = await seedInvoice(tenantA.id, custA.id, 100);

      const singletonBefore = await prisma.paymentCounter.findUnique({
        where: { id: "singleton" },
      });

      // No tenantCtx.run() wrapper — genuinely null ambient tenant.
      let outcome: string;
      try {
        const result = await invoicesService.recordStandalonePayment({
          customerId: custA.id,
          totalAmount: 5,
          method: "CASH",
          allocations: [{ invoiceId: invoiceA.id, amount: 5 }],
        } as any);
        outcome = result.payments[0].paymentNumber;
      } catch (err: any) {
        outcome = `<threw ${err?.constructor?.name}>`;
      }

      expect(outcome).toBe("<threw BadRequestException>");

      const singletonAfter = await prisma.paymentCounter.findUnique({
        where: { id: "singleton" },
      });
      expect(singletonAfter?.next ?? null).toBe(singletonBefore?.next ?? null);
    }, 30_000);
  },
);
