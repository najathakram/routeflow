/**
 * Owner issue #2088 - real Postgres: "Email again" with the tracked send state.
 *  - a first email is recorded (one `invoice.emailed` audit row with the versioned content fingerprint); the
 *    state is `unchanged` until the invoice content changes, then `changedSinceSent`, and `unchanged` again after
 *    the re-send;
 *  - re-emailing a PAID invoice keeps it PAID and keeps the FIRST `sentAt`;
 *  - a DRAFT revert nulls `sentAt` but the send history (the audit rows) survives;
 *  - an invoice with a legacy `sentAt` and no tracked row reads `sentBeforeTracking`;
 *  - the sixth email inside the window is a coded 429.
 * Throwaway `qa-resend-*` tenants approved by `assertTestTenant`; collected only by jest.db.config.js.
 */

// Prevent Jest from traversing ESM-only dependencies (same guard as invoices.service.spec.ts /
// invoice-numbering.db.spec.ts).
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

describeDb("Invoice re-email: tracked send state - real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoicesService: InvoicesService;
  let tenantId = "";
  let customerId = "";
  const actor = "11111111-1111-4111-8111-111111111111";

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
    download: jest.fn().mockResolvedValue(Buffer.from("pdf")),
  };
  const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
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
        entitlementAuthorityFromEntitlements, // #2241
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
      ],
    }).compile();

    invoicesService = module.get(InvoicesService);

    const slug = assertTestTenant(`qa-resend-${RUN_SUFFIX}`, "invoices.resend-state.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `Resend ${slug}` } })).id;
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
          businessName: "Resend co",
          contactName: "T",
          email: "ap@resend.test",
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
      await prisma.systemConfig.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  const run = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const create = async () =>
    (
      (await run(() =>
        invoicesService.create({
          customerId,
          items: [{ description: "Widget", qty: 2, unitPrice: 50 }],
        } as never),
      )) as { id: string }
    ).id;
  // "final": the stage a SENT invoice sends at by default, so the state after a send is not a stage change
  const email = (id: string, variant: "draft" | "final" = "final") =>
    run(() => invoicesService.sendEmail(id, undefined, variant, actor));
  const state = async (id: string) =>
    (
      (await run(() =>
        invoicesService.findOne(id, { role: "OPERATOR", sub: actor, tenantId } as never),
      )) as any
    ).sendState;
  const row = (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id } });
  const emailed = (id: string) =>
    prisma.auditLog.count({
      where: { entityType: "invoice", entityId: id, action: "invoice.emailed" },
    });

  it("first email: never -> one tracked row -> unchanged; a content change -> changedSinceSent; re-send -> unchanged", async () => {
    const id = await create();
    expect((await state(id)).state).toBe("never");

    await email(id);
    expect(await state(id)).toMatchObject({ state: "unchanged", lastSentTo: "ap@resend.test" });
    expect(await emailed(id)).toBe(1);

    // the order is edited after the email: the invoice's customer-visible content changes
    await prisma.invoice.update({ where: { id }, data: { subject: "Now with a subject" } });
    expect((await state(id)).state).toBe("changedSinceSent");

    await email(id);
    expect((await state(id)).state).toBe("unchanged");
    expect(await emailed(id)).toBe(2);
  }, 60_000);

  it("a proforma emailed from a DRAFT and then issued reads as modified: the FINAL is a different document", async () => {
    const id = await create();
    await email(id, "draft"); // the DRAFT-stamped proforma; the send issues the invoice (DRAFT -> SENT)
    expect((await row(id)).status).toBe("SENT");
    expect((await state(id)).state).toBe("changedSinceSent"); // an Email again would now send the FINAL stage
    await email(id, "final");
    expect((await state(id)).state).toBe("unchanged");
  }, 60_000);

  it("an internal-only change does not read as modified", async () => {
    const id = await create();
    await email(id);
    await prisma.invoice.update({ where: { id }, data: { internalNotes: "call before shipping" } });
    expect((await state(id)).state).toBe("unchanged");
  }, 60_000);

  it("re-emailing a PAID invoice keeps it PAID and keeps the FIRST sentAt", async () => {
    const id = await create();
    await email(id);
    const sentAt = (await row(id)).sentAt;
    expect(sentAt).not.toBeNull();
    // a real PAID invoice: a confirmed payment for the whole total (markSent recomputes the status from payments)
    await prisma.invoicePayment.create({
      data: {
        invoiceId: id,
        tenantId,
        amount: 100,
        method: "CASH",
        status: "PAID",
        paidAt: new Date(),
      },
    });
    await prisma.invoice.update({ where: { id }, data: { status: "PAID", paidAt: new Date() } });
    await new Promise((r) => setTimeout(r, 25));
    await email(id);
    const after = await row(id);
    expect(after.status).toBe("PAID");
    expect(after.sentAt?.getTime()).toBe(sentAt?.getTime());
  }, 60_000);

  it("a DRAFT revert nulls sentAt but the send history survives", async () => {
    const id = await create();
    await email(id);
    await run(() => invoicesService.revertInvoiceToDraft(id));
    expect((await row(id)).sentAt).toBeNull();
    const s = await state(id);
    expect(s.state).toBe("unchanged");
    expect(s.lastSentAt).not.toBeNull();
  }, 60_000);

  it("a sentAt after the tracking cutover with no tracked row was only MARKED sent, not emailed", async () => {
    const id = await create();
    await prisma.invoice.update({
      where: { id },
      data: { status: "SENT", sentAt: new Date("2027-01-05T10:00:00Z") },
    });
    expect(await state(id)).toMatchObject({
      state: "markedSentNotEmailed",
      lastSentAt: "2027-01-05T10:00:00.000Z",
      lastSentTo: null,
    });
  }, 60_000);

  it("a legacy sentAt (before the cutover) with no tracked row reads sentBeforeTracking", async () => {
    const id = await create();
    await prisma.invoice.update({
      where: { id },
      data: { status: "SENT", sentAt: new Date("2026-09-01T10:00:00Z") },
    });
    expect(await state(id)).toMatchObject({
      state: "sentBeforeTracking",
      lastSentAt: "2026-09-01T10:00:00.000Z",
    });
  }, 60_000);

  it("the sixth email inside the window is a coded 429 and sends nothing", async () => {
    const id = await create();
    for (let i = 0; i < 5; i += 1) await email(id);
    const before = mockEmailService.sendInvoice.mock.calls.length;
    await expect(email(id)).rejects.toMatchObject({
      status: 429,
      response: { code: "EMAIL_SEND_THROTTLED" },
    });
    expect(mockEmailService.sendInvoice.mock.calls.length).toBe(before);
  }, 90_000);

  it("a VOID invoice is still refused", async () => {
    const id = await create();
    await prisma.invoice.update({ where: { id }, data: { status: "VOID" } });
    await expect(email(id)).rejects.toMatchObject({ status: 400 });
  }, 60_000);
});
