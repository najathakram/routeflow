/**
 * SA-1508 commit 2 (SA-1506 R-197-D F2) - real Postgres: the operator's Revert to draft is locked and re-read.
 *
 * `revertInvoiceToDraft` read the status and the live-payment count BEFORE its transaction and wrote by id, so
 * a void (or a payment) committed between the read and the write was overwritten: the VOID invoice came back as
 * a DRAFT, or an invoice with a payment row became a DRAFT. The fix takes `lockInvoiceRow` as the transaction's
 * first statement, re-judges the status and the non-VOID payment count on the locked row, and writes with a
 * status predicate.
 *
 * The race is made deterministic by committing the competing write from inside `tenantTransaction`, before the
 * transaction starts: exactly between the pre-reads and the transaction.
 * Throwaway `qa-revert-*` tenants approved by `assertTestTenant`; collected only by jest.db.config.js.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
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
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);

describeDb("Operator Revert to draft: lock + re-read - real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoicesService: InvoicesService;
  let tenantId = "";
  let customerId = "";

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        SellingRestrictionsService,
        ProductLabelsService,
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        { provide: EmailService, useValue: { isEmailConfigured: jest.fn() } },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null), getAll: jest.fn() },
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
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
      ],
    }).compile();

    invoicesService = module.get(InvoicesService);

    const slug = assertTestTenant(`qa-revert-${RUN_SUFFIX}`, "revert.void-race.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `Revert ${slug}` } })).id;
    const user = await prisma.user.create({
      data: {
        email: `buyer-${RUN_SUFFIX}@example.invalid`,
        username: `buyer-${RUN_SUFFIX}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    customerId = (
      await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: "Revert co",
          contactName: "T",
          email: "ap@revert.test",
          tenantId,
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      const ids = (
        await prisma.invoice.findMany({ where: { tenantId }, select: { id: true } })
      ).map((i) => i.id);
      await prisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.invoiceItem.deleteMany({ where: { tenantId } }).catch(() => undefined);
      if (ids.length)
        await prisma.invoicePayment
          .deleteMany({ where: { invoiceId: { in: ids } } })
          .catch(() => undefined);
      await prisma.invoice.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.numberingSequence.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.customer.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  const run = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const SENT_AT = new Date("2026-11-01T10:00:00Z");
  /** A standalone SENT invoice (no order, no payments). */
  const createSent = async () => {
    const id = (
      (await run(() =>
        invoicesService.create({
          customerId,
          items: [{ description: "Widget", qty: 2, unitPrice: 50 }],
        } as never),
      )) as { id: string }
    ).id;
    await prisma.invoice.update({ where: { id }, data: { status: "SENT", sentAt: SENT_AT } });
    return id;
  };
  const row = (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id } });

  /** Commits `competing` AFTER the revert's pre-reads returned and BEFORE its transaction starts. */
  const raceBeforeTransaction = (competing: () => Promise<unknown>) => {
    const original = prisma.tenantTransaction.bind(prisma);
    return jest
      .spyOn(prisma, "tenantTransaction")
      .mockImplementationOnce(async (...args: Parameters<typeof original>) => {
        await competing();
        return original(...args);
      });
  };

  it("a void committed after the pre-reads is not overwritten: the revert refuses and the invoice stays VOID", async () => {
    const id = await createSent();
    raceBeforeTransaction(() => prisma.invoice.update({ where: { id }, data: { status: "VOID" } }));

    await expect(run(() => invoicesService.revertInvoiceToDraft(id))).rejects.toMatchObject({
      status: 400,
    });

    const after = await row(id);
    expect(after.status).toBe("VOID"); // master: DRAFT (the revert wrote over the void)
    expect(after.sentAt?.getTime()).toBe(SENT_AT.getTime()); // master: null
  }, 60_000);

  it("a payment row committed after the pre-reads blocks the revert: the invoice keeps its status", async () => {
    const id = await createSent();
    raceBeforeTransaction(() =>
      prisma.invoicePayment.create({
        data: {
          invoiceId: id,
          tenantId,
          amount: 100,
          method: "CASH",
          status: "PAID",
          paidAt: new Date(),
        },
      }),
    );

    await expect(run(() => invoicesService.revertInvoiceToDraft(id))).rejects.toMatchObject({
      status: 400,
    });

    const after = await row(id);
    expect(after.status).toBe("SENT"); // master: DRAFT, with the payment row still on it
    expect(await prisma.invoicePayment.count({ where: { invoiceId: id } })).toBe(1);
  }, 60_000);

  it("an uncontended revert still works: DRAFT, sentAt cleared", async () => {
    const id = await createSent();
    await run(() => invoicesService.revertInvoiceToDraft(id));
    const after = await row(id);
    expect(after.status).toBe("DRAFT");
    expect(after.sentAt).toBeNull();
  }, 60_000);
});
