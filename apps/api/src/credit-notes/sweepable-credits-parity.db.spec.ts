/**
 * SA-998 — real-Postgres parity pin for the counter part-pay cap. For each fixture the operator statement's
 * `autoApplyCredit` (read through the real `buildOperatorStatement`, the figure the counter web caps on) must equal
 * the credit the REAL send-time sweep (`invoices.send` → `autoApplyOldestCreditsInTx`) applies to the sale's
 * invoice, as `min(total, autoApplyCredit)`. Both read the one `sweepableCredits` helper, so a future change to the
 * selection moves the cap and the sweep together. A split-invoice sale is not pinned here: the lane reports it
 * (the applied sum across the sale's invoices) in the PR.
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-sa998-*` slug approved by
 * `assertTestTenant`; `afterAll` deletes exactly what this run created. No client identifiers.
 */
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { CreditNotesService } from "./credit-notes.service";
import { buildOperatorStatement } from "../customers/customer-statement";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "SA-998 sweepableCredits: the statement autoApplyCredit equals what the send-time sweep applies",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoices: InvoicesService;
    let creditNotes: CreditNotesService;
    const tenantIds: string[] = [];
    let seq = 0;

    const mockLedger = {
      reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
      unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
      settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
    };
    const mockCommissionEngine = {
      syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
      syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
      removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
    };

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      const mod = await Test.createTestingModule({
        providers: [
          InvoicesService,
          CreditNotesService,
          {
            provide: SellingRestrictionsService,
            useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
          },
          EstimatesService,
          NumberingService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: RouteFlowGateway,
            useValue: {
              emitInvoiceUpdated: jest.fn(),
              emitOrderCreated: jest.fn(),
              emitOrderStatusChanged: jest.fn(),
              emitLowStock: jest.fn(),
              emitStopCompleted: jest.fn(),
              emitUrgentOrder: jest.fn(),
              emitCreditNoteCreated: jest.fn(),
              emitCreditNoteVoided: jest.fn(),
            },
          },
          {
            provide: EmailService,
            useValue: {
              sendInvoice: jest.fn(),
              isEmailConfigured: jest.fn().mockResolvedValue(true),
            },
          },
          { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
          {
            provide: SystemConfigService,
            useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
          },
          { provide: RegulatedLedgerService, useValue: mockLedger },
          {
            provide: AuthorizationGuardService,
            useValue: {
              assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
              checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
            },
          },
          {
            provide: MessagingService,
            useValue: {
              notify: jest.fn().mockResolvedValue([]),
              notifyEvent: jest.fn().mockResolvedValue(undefined),
            },
          },
          {
            provide: StorageService,
            useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
          },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          entitlementAuthorityFromEntitlements, // #2241
          { provide: CommissionEngineService, useValue: mockCommissionEngine },
        ],
      }).compile();
      invoices = mod.get(InvoicesService);
      creditNotes = mod.get(CreditNotesService);
    });

    afterAll(async () => {
      const swallow = () => undefined; // a failed cleanup must never mask a test's result
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        await prisma.creditNoteApplyBlock.deleteMany(where).catch(swallow);
        await prisma.invoicePayment.deleteMany(where).catch(swallow);
        await prisma.orderCreditNote.deleteMany(where).catch(swallow);
        await prisma.creditNoteItem.deleteMany(where).catch(swallow);
        await prisma.creditNote.deleteMany(where).catch(swallow);
        await prisma.paymentCounter.deleteMany(where).catch(swallow);
        await prisma.auditLog.deleteMany(where).catch(swallow);
        await prisma.tenantConfig.deleteMany(where).catch(swallow);
        await prisma.invoiceItem.deleteMany(where).catch(swallow);
        await prisma.invoice.deleteMany(where).catch(swallow);
        await prisma.orderItem.deleteMany(where).catch(swallow);
        await prisma.order.deleteMany(where).catch(swallow);
        await prisma.product.deleteMany(where).catch(swallow);
        await prisma.customer.deleteMany(where).catch(swallow);
        await prisma.user.deleteMany(where).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
    });

    /** A fresh tenant (+ optional TenantConfig row) with one customer. */
    async function seedTenant(label: string, autoApplyOnSend: boolean | null) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-sa998-${RUN}-${seq}-${label}`,
        "sweepable-credits-parity.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `SA-998 ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      if (autoApplyOnSend !== null) {
        await prisma.tenantConfig.create({
          data: { tenantId, creditAutoApplyOnSend: autoApplyOnSend },
        });
      }
      const user = await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
      });
      return { tenantId, customerId: customer.id };
    }

    /** A DRAFT invoice with one goods line, ready to `invoices.send`. */
    async function seedDraftInvoice(tenantId: string, customerId: string, total: number) {
      seq += 1;
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId,
          invoiceNumber: `INV-998-${RUN}-${seq}`,
          status: "DRAFT",
          subtotal: total,
          total,
        },
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          description: `goods ${seq}`,
          qty: 1,
          unitPrice: total,
          taxRate: 0,
          subtotal: total,
        },
      });
      return invoice.id as string;
    }

    /** A minted, ISSUED, standalone open credit note via the REAL create() path, backdated to
     * control oldest-first ordering when `ageMinutesAgo` is given. */
    async function seedOpenCredit(
      tenantId: string,
      customerId: string,
      amount: number,
      ageMinutesAgo = 0,
    ) {
      const cn = await tenantCtx.run(tenantId, () =>
        creditNotes.create({ customerId, amount } as any),
      );
      if (ageMinutesAgo > 0) {
        await prisma.creditNote.update({
          where: { id: cn.id },
          data: { createdAt: new Date(Date.now() - ageMinutesAgo * 60_000) },
        });
      }
      return cn.id as string;
    }

    async function blocksFor(creditNoteId: string) {
      return prisma.creditNoteApplyBlock.findMany({ where: { creditNoteId } });
    }

    async function activePaymentsFor(creditNoteId: string, invoiceId?: string) {
      return prisma.invoicePayment.findMany({
        where: {
          creditNoteId,
          method: "CREDIT_NOTE",
          status: { not: "VOID" },
          ...(invoiceId ? { invoiceId } : {}),
        },
      });
    }

    const readCap = async (tenantId: string, customerId: string): Promise<any> =>
      tenantCtx.run(tenantId, () =>
        buildOperatorStatement(prisma, customerId, { includeExposure: true }),
      );

    /** The credit the real sweep applied to one invoice: the sum of its active CREDIT_NOTE payments. */
    async function appliedToInvoice(invoiceId: string): Promise<number> {
      const pays = await prisma.invoicePayment.findMany({
        where: { invoiceId, method: "CREDIT_NOTE", status: { not: "VOID" } },
      });
      return pays.reduce((sum, p) => sum + Number(p.amount), 0);
    }

    /** Read the statement's figure, then send a fresh invoice (the sweep): what the read said vs what was applied. */
    async function readThenSweep(tenantId: string, customerId: string, total: number) {
      const invoiceId = await seedDraftInvoice(tenantId, customerId, total);
      const stmt = await readCap(tenantId, customerId);
      await tenantCtx.run(tenantId, () => invoices.send(invoiceId, { allowPreDelivery: true }));
      return {
        stmt,
        read: Math.min(total, stmt.autoApplyCredit as number),
        applied: await appliedToInvoice(invoiceId),
      };
    }

    it("flag OFF (no config row): the read is 0 and the sweep applies 0, though availableCredit shows the note", async () => {
      const { tenantId, customerId } = await seedTenant("off", null);
      await seedOpenCredit(tenantId, customerId, 30);
      const { read, applied, stmt } = await readThenSweep(tenantId, customerId, 100);
      expect(stmt.autoApplyCredit).toBe(0);
      expect(stmt.availableCredit).toBe(30); // the display wallet is unchanged
      expect([read, applied]).toEqual([0, 0]);
    }, 30_000);

    it("flag ON, one open note: the read and the sweep agree on 30", async () => {
      const { tenantId, customerId } = await seedTenant("one", true);
      await seedOpenCredit(tenantId, customerId, 30);
      const { read, applied } = await readThenSweep(tenantId, customerId, 100);
      expect([read, applied]).toEqual([30, 30]);
    }, 30_000);

    it("an excluded note is in neither", async () => {
      const { tenantId, customerId } = await seedTenant("excl", true);
      const id = await seedOpenCredit(tenantId, customerId, 30);
      await tenantCtx.run(tenantId, () => creditNotes.setAutoApplyExcluded(id, true, null));
      const { read, applied } = await readThenSweep(tenantId, customerId, 100);
      expect([read, applied]).toEqual([0, 0]);
    }, 30_000);

    it("an expired note is in neither", async () => {
      const { tenantId, customerId } = await seedTenant("exp", true);
      const id = await seedOpenCredit(tenantId, customerId, 30);
      await prisma.creditNote.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 86_400_000) },
      });
      const { read, applied } = await readThenSweep(tenantId, customerId, 100);
      expect([read, applied]).toEqual([0, 0]);
    }, 30_000);

    it("a VOID note is in neither", async () => {
      const { tenantId, customerId } = await seedTenant("void", true);
      const id = await seedOpenCredit(tenantId, customerId, 30);
      await prisma.creditNote.update({ where: { id }, data: { status: "VOID" } });
      const { read, applied } = await readThenSweep(tenantId, customerId, 100);
      expect([read, applied]).toEqual([0, 0]);
    }, 30_000);

    it("an inline-return note whose carrying order is NOT met is in neither; once that order is paid it is in both", async () => {
      const { tenantId, customerId } = await seedTenant("inline", true);
      const noteId = await seedOpenCredit(tenantId, customerId, 30);
      const order = await prisma.order.create({
        data: { tenantId, customerId, status: "PENDING", total: 50 },
      });
      await prisma.return.create({
        data: {
          tenantId,
          customerId,
          orderId: order.id,
          returnNumber: `RET-998-${RUN}`,
          reason: "DAMAGED",
          status: "REFUNDED",
          kind: "INLINE",
          creditNoteId: noteId,
        } as any,
      });
      // not met: the carrying order has no invoice yet
      const first = await readThenSweep(tenantId, customerId, 100);
      expect([first.read, first.applied]).toEqual([0, 0]);
      // met: a fully paid, non-VOID invoice on the carrying order
      const paid = await prisma.invoice.create({
        data: {
          tenantId,
          customerId,
          orderId: order.id,
          invoiceNumber: `INV-998-PAID-${RUN}`,
          status: "PAID",
          subtotal: 50,
          total: 50,
        },
      });
      await prisma.invoicePayment.create({
        data: {
          tenantId,
          invoiceId: paid.id,
          amount: 50,
          method: "CASH",
          status: "PAID",
        } as any,
      });
      const second = await readThenSweep(tenantId, customerId, 100);
      expect([second.read, second.applied]).toEqual([30, 30]);
    }, 30_000);

    it("three notes oldest first: the read is their sum and the sweep applies the same", async () => {
      const { tenantId, customerId } = await seedTenant("three", true);
      await seedOpenCredit(tenantId, customerId, 10, 30);
      await seedOpenCredit(tenantId, customerId, 20, 20);
      await seedOpenCredit(tenantId, customerId, 15, 10);
      const { read, applied } = await readThenSweep(tenantId, customerId, 100);
      expect([read, applied]).toEqual([45, 45]);
    }, 30_000);

    it("credit above the total: both are capped at the total", async () => {
      const { tenantId, customerId } = await seedTenant("above", true);
      await seedOpenCredit(tenantId, customerId, 80);
      await seedOpenCredit(tenantId, customerId, 80);
      const { read, applied, stmt } = await readThenSweep(tenantId, customerId, 100);
      expect(stmt.autoApplyCredit).toBe(160);
      expect([read, applied]).toEqual([100, 100]);
    }, 30_000);
  },
);
