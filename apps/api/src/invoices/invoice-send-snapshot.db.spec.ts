/**
 * W-702 / SA-860: the issuing email is rendered from ONE snapshot taken inside a rolled-back dry run of the real send-time
 * credits. REAL Postgres, the REAL InvoicesService and the REAL CreditNotesService; the transport, the PDF and the
 * gateway are spies. Cases R1-R5 (R6 and R7 are the static pins in invoice-send-snapshot.pins.spec.ts plus the spy checks in R1).
 * Collected only by jest.db.config.js (`npm run local:test:db`); every tenant is a throwaway qa- slug.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({ getOrGenerate: jest.fn() })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { BadRequestException } from "@nestjs/common";
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
import { FINGERPRINT_INCLUDE, invoiceFingerprint } from "./invoice-send-state";
import { SEND_SNAPSHOT_INCLUDE } from "./invoice-send-snapshot";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const ACTOR = "11111111-1111-4111-8111-111111111111";

describeDb("SA-860 the email snapshot, real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  let creditNotes: CreditNotesService;
  const tenantIds: string[] = [];
  let seq = 0;

  const gateway = {
    emitInvoiceUpdated: jest.fn(),
    emitOrderCreated: jest.fn(),
    emitOrderStatusChanged: jest.fn(),
    emitLowStock: jest.fn(),
    emitStopCompleted: jest.fn(),
    emitUrgentOrder: jest.fn(),
    emitCreditNoteCreated: jest.fn(),
    emitCreditNoteVoided: jest.fn(),
  };
  const email = {
    sendInvoice: jest.fn(),
    isEmailConfigured: jest.fn().mockResolvedValue(true),
  };
  const messaging = {
    notify: jest.fn().mockResolvedValue([]),
    notifyEvent: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    upload: jest.fn(),
    presignedUrl: jest.fn(),
    delete: jest.fn(),
    download: jest.fn().mockResolvedValue(Buffer.from("pdf")),
  };
  const pdf = { getOrGenerate: jest.fn() };

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const mod = await Test.createTestingModule({
      providers: [
        InvoicesService,
        CreditNotesService,
        ProductLabelsService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: gateway },
        { provide: EmailService, useValue: email },
        { provide: InvoicePdfService, useValue: pdf },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
        },
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
            unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        { provide: MessagingService, useValue: messaging },
        { provide: StorageService, useValue: storage },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    invoices = mod.get(InvoicesService);
    creditNotes = mod.get(CreditNotesService);
  }, 120_000);

  beforeEach(() => {
    email.sendInvoice.mockReset().mockResolvedValue({ delivered: true, transport: "resend" });
    pdf.getOrGenerate.mockReset().mockResolvedValue(undefined);
    for (const g of Object.values(gateway)) g.mockClear();
    messaging.notify.mockClear();
    messaging.notifyEvent.mockClear();
    storage.upload.mockClear();
  });

  afterAll(async () => {
    const swallow = () => undefined;
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
      await prisma.numberingSequence.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  async function seedTenant(label: string, autoApplyOnSend: boolean) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-860-${RUN}-${seq}-${label}`,
      "invoice-send-snapshot.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `W-702 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, creditAutoApplyOnSend: autoApplyOnSend },
    });
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `c ${label}`,
        contactName: `c ${label}`,
        email: `ap-${slug}@example.test`,
        tenantId,
      },
    });
    return { tenantId, customerId: customer.id };
  }

  async function seedDraftInvoice(tenantId: string, customerId: string, total: number) {
    seq += 1;
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-860-${RUN}-${seq}`,
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

  const seedCredit = async (tenantId: string, customerId: string, amount: number) =>
    (await tenantCtx.run(tenantId, () => creditNotes.create({ customerId, amount } as any)))
      .id as string;
  const send = (tenantId: string, id: string) =>
    tenantCtx.run(tenantId, () => invoices.sendEmail(id, undefined, "final", ACTOR));
  const creditRows = (invoiceId: string) =>
    prisma.invoicePayment.findMany({
      where: { invoiceId, method: "CREDIT_NOTE", status: { not: "VOID" } },
    });
  const sendState = async (tenantId: string, id: string) =>
    (
      (await tenantCtx.run(tenantId, () =>
        invoices.findOne(id, { role: "OPERATOR", sub: ACTOR, tenantId } as never),
      )) as any
    ).sendState;
  const emailedRows = (id: string) =>
    prisma.auditLog.findMany({
      where: { entityType: "invoice", entityId: id, action: "invoice.emailed" },
      orderBy: { createdAt: "asc" },
    });

  it("R1: the issuing email shows the POST-credit balance; the note moves exactly once; the dry run made no non-DB call", async () => {
    const { tenantId, customerId } = await seedTenant("r1", true);
    const id = await seedDraftInvoice(tenantId, customerId, 100);
    const noteId = await seedCredit(tenantId, customerId, 30);
    let atPdf: Record<string, number> = {};
    pdf.getOrGenerate.mockImplementation(async () => {
      // R6 (dynamic): by the time the PDF is built the dry run is over; none of these had been touched during it.
      atPdf = {
        gateway: gateway.emitInvoiceUpdated.mock.calls.length,
        messaging: messaging.notifyEvent.mock.calls.length + messaging.notify.mock.calls.length,
        email: email.sendInvoice.mock.calls.length,
        storage: storage.upload.mock.calls.length,
      };
      return undefined;
    });

    await send(tenantId, id);

    expect(atPdf).toEqual({ gateway: 0, messaging: 0, email: 0, storage: 0 });
    const payload = email.sendInvoice.mock.calls[0][0];
    expect(payload).toMatchObject({ balanceDue: 70, creditApplied: 30 });
    expect(payload.creditNoteNumbers).toHaveLength(1);
    // R7: the PDF is handed the snapshot model, with the credit row in its payment listing
    const opts = pdf.getOrGenerate.mock.calls[0][1];
    expect(opts.model.payments.map((p: any) => p.method)).toContain("CREDIT_NOTE");
    // one application, in the real transaction
    expect(await creditRows(id)).toHaveLength(1);
    expect(
      Number((await prisma.creditNote.findUnique({ where: { id: noteId } }))!.amountUsed),
    ).toBe(30);
    expect((await sendState(tenantId, id)).state).toBe("unchanged");
  }, 120_000);

  it("R2: a failed transport leaves the invoice DRAFT, the note unused and no send record (R5 / P5-13)", async () => {
    const { tenantId, customerId } = await seedTenant("r2", true);
    const id = await seedDraftInvoice(tenantId, customerId, 100);
    const noteId = await seedCredit(tenantId, customerId, 30);
    email.sendInvoice.mockResolvedValue({ delivered: false, error: "smtp down" });

    await expect(send(tenantId, id)).rejects.toBeInstanceOf(BadRequestException);

    expect((await prisma.invoice.findUnique({ where: { id } }))!.status).toBe("DRAFT");
    expect(
      Number((await prisma.creditNote.findUnique({ where: { id: noteId } }))!.amountUsed),
    ).toBe(0);
    expect(await creditRows(id)).toHaveLength(0);
    expect(await emailedRows(id)).toHaveLength(0);
  }, 120_000);

  it("R3: another invoice consumes the note between the dry run and the commit: no double application, one correction record", async () => {
    const { tenantId, customerId } = await seedTenant("r3", true);
    const id = await seedDraftInvoice(tenantId, customerId, 100);
    const other = await seedDraftInvoice(tenantId, customerId, 100);
    const noteId = await seedCredit(tenantId, customerId, 30);
    // the transport call sits between the dry run and markSent: a competing writer takes the whole note there
    email.sendInvoice.mockImplementationOnce(async () => {
      await tenantCtx.run(tenantId, () => creditNotes.applyToInvoice(noteId, other, 30));
      return { delivered: true, transport: "resend" };
    });

    await send(tenantId, id);

    expect(
      Number((await prisma.creditNote.findUnique({ where: { id: noteId } }))!.amountUsed),
    ).toBe(30);
    expect(await creditRows(id)).toHaveLength(0); // the real sweep found nothing left for this invoice
    expect(await creditRows(other)).toHaveLength(1);
    const rows = await emailedRows(id);
    expect(rows).toHaveLength(2);
    expect((rows[1].meta as any).fp).toBeNull();
    expect((rows[1].meta as any).note).toMatch(/may not match the credits applied/);
    expect((await sendState(tenantId, id)).state).toBe("sentBeforeTracking");
  }, 120_000);

  it("R4: switch OFF, an explicit order credit intent: the issuing email shows the intent's credit", async () => {
    const { tenantId, customerId } = await seedTenant("r4", false);
    const id = await seedDraftInvoice(tenantId, customerId, 100);
    const order = await prisma.order.create({
      data: { tenantId, customerId, status: "PENDING", total: 100 },
    });
    await prisma.invoice.update({ where: { id }, data: { orderId: order.id } });
    const noteId = await seedCredit(tenantId, customerId, 40);
    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx) => {
        await creditNotes.syncOrderCreditSelections(tx, order.id, customerId, [
          { creditNoteId: noteId, amount: 40 },
        ]); // recorded, NOT yet settled: the send settles it
      }),
    );
    // the order is delivered so the DRAFT invoice is sendable
    await prisma.order.update({ where: { id: order.id }, data: { status: "DELIVERED" } });
    let atPdf: Record<string, number> = {};
    pdf.getOrGenerate.mockImplementation(async () => {
      // SA-874: the settle path (an order intent) is the one R1 never runs; none of these may have fired during the dry run
      atPdf = {
        gateway: gateway.emitInvoiceUpdated.mock.calls.length,
        messaging: messaging.notifyEvent.mock.calls.length + messaging.notify.mock.calls.length,
        email: email.sendInvoice.mock.calls.length,
        storage: storage.upload.mock.calls.length,
      };
      return undefined;
    });

    await send(tenantId, id);

    expect(atPdf).toEqual({ gateway: 0, messaging: 0, email: 0, storage: 0 });

    expect(email.sendInvoice.mock.calls[0][0]).toMatchObject({ balanceDue: 60, creditApplied: 40 });
    expect(await creditRows(id)).toHaveLength(1);
  }, 120_000);

  describe("SA-874 MUST 1: the dry run and the commit hash the same rows alike", () => {
    // ONE invoice with 4 lines created in a single nested create: they share createdAt and get random uuids
    const seedMultiLine = async (tenantId: string, customerId: string) => {
      seq += 1;
      const inv = await prisma.invoice.create({
        data: {
          tenantId,
          customerId,
          invoiceNumber: `INV-860-${RUN}-${seq}`,
          status: "DRAFT",
          subtotal: 100,
          total: 100,
          items: {
            create: [1, 2, 3, 4].map((n) => ({
              tenantId,
              description: `line ${n}`,
              qty: 1,
              unitPrice: 25,
              taxRate: 0,
              subtotal: 25,
            })),
          },
        } as any,
      });
      return inv.id as string;
    };
    const fp = (inv: any) => invoiceFingerprint({ ...inv, variant: "final" });

    it("M1a: a multi-line invoice whose lines share createdAt reads in ONE item order through both includes", async () => {
      const { tenantId, customerId } = await seedTenant("m1a", true);
      const id = await seedMultiLine(tenantId, customerId);
      const live = await prisma.invoice.findUnique({ where: { id }, include: FINGERPRINT_INCLUDE });
      const snap = await prisma.invoice.findUnique({
        where: { id },
        include: SEND_SNAPSHOT_INCLUDE,
      });
      expect(snap!.items.map((i) => i.id)).toEqual(live!.items.map((i) => i.id));
      expect(fp(snap)).toBe(fp(live));
    }, 120_000);

    it("M1b: two payments with an identical paidAt and ids in the REVERSE of content order read in content order through both includes", async () => {
      const { tenantId, customerId } = await seedTenant("m1b", true);
      const id = await seedDraftInvoice(tenantId, customerId, 100);
      const paidAt = new Date("2026-10-05T12:00:00.000Z");
      // ids chosen so id order is the reverse of amount (content) order
      await prisma.invoicePayment.create({
        data: {
          id: "ffffffff-0000-4000-8000-000000000001",
          invoiceId: id,
          tenantId,
          amount: 10,
          method: "CASH",
          status: "PAID",
          paidAt,
        } as any,
      });
      await prisma.invoicePayment.create({
        data: {
          id: "00000000-0000-4000-8000-000000000002",
          invoiceId: id,
          tenantId,
          amount: 20,
          method: "CASH",
          status: "PAID",
          paidAt,
        } as any,
      });
      const live = await prisma.invoice.findUnique({ where: { id }, include: FINGERPRINT_INCLUDE });
      const snap = await prisma.invoice.findUnique({
        where: { id },
        include: SEND_SNAPSHOT_INCLUDE,
      });
      const contentOrder = [10, 20];
      expect(live!.payments.map((x) => Number(x.amount))).toEqual(contentOrder);
      expect(snap!.payments.map((x) => Number(x.amount))).toEqual(contentOrder);
    }, 120_000);

    it("M1c: an issuing send that applies TWO open notes records exactly one send and reads unchanged", async () => {
      const { tenantId, customerId } = await seedTenant("m1c", true);
      const id = await seedDraftInvoice(tenantId, customerId, 100);
      await seedCredit(tenantId, customerId, 30);
      await seedCredit(tenantId, customerId, 30);

      await send(tenantId, id);

      expect(await creditRows(id)).toHaveLength(2);
      expect(await emailedRows(id)).toHaveLength(1);
      expect((await sendState(tenantId, id)).state).toBe("unchanged");
    }, 120_000);

    it("an ordinary multi-line send (lines sharing createdAt) records one send and reads unchanged", async () => {
      const { tenantId, customerId } = await seedTenant("mline", true);
      const id = await seedMultiLine(tenantId, customerId);

      await send(tenantId, id);

      expect(await emailedRows(id)).toHaveLength(1);
      expect((await sendState(tenantId, id)).state).toBe("unchanged");
    }, 120_000);
  });

  it("R5: a re-send of an issued invoice shows and moves no new credit; its fingerprint is the snapshot's", async () => {
    const { tenantId, customerId } = await seedTenant("r5", true);
    const id = await seedDraftInvoice(tenantId, customerId, 100);
    await send(tenantId, id); // issues (no credit exists yet)
    await seedCredit(tenantId, customerId, 25); // a new open note after the first send
    email.sendInvoice.mockClear();

    await send(tenantId, id); // Email again

    expect(email.sendInvoice.mock.calls[0][0]).toMatchObject({ creditApplied: 0, balanceDue: 100 });
    expect(await creditRows(id)).toHaveLength(0);
    expect((await sendState(tenantId, id)).state).toBe("unchanged");
  }, 120_000);
});
