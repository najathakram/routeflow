/**
 * #2648 / SA-535(b), SA-535a, SA-535b — real-Postgres proof of the credit-note reissue (an
 * amount/line edit = void-with-reversal + an unapplied replacement, in ONE transaction):
 *
 *  1. an applied note: its applications are reversed (invoices reopen, apply blocks written),
 *     the old note is VOID, the new note is ISSUED + unapplied against the SAME source invoice,
 *     VOIDED / SUPERSEDED / REISSUED audit rows land, the ledger is counter-entered once;
 *  2. atomicity: a forced failure AFTER the void rolls everything back (old note untouched,
 *     applications intact, no blocks, no audit, no new note);
 *  3. headroom: the dry run frees exactly the old note's own headroom — equal passes, above
 *     refuses with 409 and burns no credit-note number;
 *  4. a live return-backed note refuses with 409 "Edit the return instead", zero writes;
 *  5. an idempotent replay returns the same new note (exactly one minted); the same key with a
 *     different body is a 409.
 *
 * Real: PrismaService, TenantContextService, InvoicesService, CreditNotesService, NumberingService,
 * IdempotencyService and CreditNoteReissueService (one Prisma client). Stubbed collaborators are the
 * set every credit-notes DB spec stubs; RegulatedLedgerService stays a mock so its calls can be
 * asserted. Runs only under `npm run local:test:db`. Every tenant is a throwaway
 * `qa-2648-<run>-<n>-<label>` slug approved by `assertTestTenant`; afterAll deletes exactly the
 * tenants this run created. No client identifiers anywhere.
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
import { ConflictException } from "@nestjs/common";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { CreditNotesService } from "./credit-notes.service";
import { CreditNoteReissueService } from "./credit-note-reissue.service";
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
import { IdempotencyService } from "../common/idempotency.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("#2648 credit-note reissue (SA-535b)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  let creditNotes: CreditNotesService;
  let reissue: CreditNoteReissueService;
  let idempotency: IdempotencyService;
  const tenantIds: string[] = [];
  const idemHashes: string[] = [];
  let seq = 0;

  const mockLedger = {
    reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
    unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
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
        CreditNoteReissueService,
        IdempotencyService,
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
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
      ],
    }).compile();
    invoices = mod.get(InvoicesService);
    creditNotes = mod.get(CreditNotesService);
    reissue = mod.get(CreditNoteReissueService);
    idempotency = mod.get(IdempotencyService);
  });

  afterEach(() => {
    mockLedger.reverseCreditNoteEntries.mockClear();
    mockLedger.unreverseCreditNoteEntries.mockClear();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    if (idemHashes.length)
      await prisma.idempotencyKey
        .deleteMany({ where: { keyHash: { in: idemHashes } } })
        .catch(swallow);
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.return.deleteMany(where).catch(swallow);
      await prisma.creditNoteApplyBlock.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.orderCreditNote.deleteMany(where).catch(swallow);
      await prisma.creditNoteItem.deleteMany(where).catch(swallow);
      await prisma.creditNote.deleteMany(where).catch(swallow);
      await prisma.paymentCounter.deleteMany(where).catch(swallow);
      await prisma.numberingSequence.deleteMany(where).catch(swallow);
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

  async function seedTenant(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-2648-${RUN}-${seq}-${label}`,
      "credit-note-reissue.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `#2648 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    return { tenantId, customerId: customer.id };
  }

  /** A SENT invoice with one goods line of `total`. */
  async function seedSentInvoice(tenantId: string, customerId: string, total: number) {
    seq += 1;
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-2648-${RUN}-${seq}`,
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
    await tenantCtx.run(tenantId, () => invoices.send(invoice.id, { allowPreDelivery: true }));
    return invoice.id as string;
  }

  /** A note sourced from `invoiceId`, minted by the REAL create() path. */
  async function seedSourcedCredit(
    tenantId: string,
    customerId: string,
    invoiceId: string,
    amount: number,
  ) {
    const cn = await tenantCtx.run(tenantId, () =>
      creditNotes.create({ customerId, invoiceId, amount, reason: "Damaged case" } as any),
    );
    return cn as { id: string; creditNoteNumber: string };
  }

  const run = (tenantId: string, id: string, dto: any, key: string, actor = randomUUID()) => {
    idemHashes.push(idempotency.hashFor(key, tenantId, `creditNoteReissue:${id}`));
    return tenantCtx.run(tenantId, () => reissue.reissue(id, dto, key, actor));
  };
  const livePayments = (creditNoteId: string) =>
    prisma.invoicePayment.findMany({
      where: { creditNoteId, method: "CREDIT_NOTE", status: { not: "VOID" } },
    });
  const audits = (tenantId: string, entityId: string) =>
    prisma.auditLog.findMany({ where: { tenantId, entityType: "CreditNote", entityId } });
  const counter = (tenantId: string) =>
    prisma.numberingSequence.findFirst({ where: { tenantId, docType: "CREDIT_NOTE" } });

  it("1: an applied note is reversed, voided and replaced by an unapplied note on the same source", async () => {
    const { tenantId, customerId } = await seedTenant("applied");
    const invSrc = await seedSentInvoice(tenantId, customerId, 50);
    const invPay = await seedSentInvoice(tenantId, customerId, 40);
    const old = await seedSourcedCredit(tenantId, customerId, invSrc, 30);
    await tenantCtx.run(tenantId, () => creditNotes.applyToInvoice(old.id, invPay, 30));
    expect((await prisma.invoice.findUnique({ where: { id: invPay } }))?.status).toBe("PARTIAL");
    mockLedger.reverseCreditNoteEntries.mockClear();
    const actor = randomUUID();

    const res = await run(tenantId, old.id, { amount: 20, reason: "Price fix" }, "k-1", actor);

    // The old note: VOID, nothing applied, its application reversed and blocked.
    const oldRow = await prisma.creditNote.findUnique({ where: { id: old.id } });
    expect(oldRow?.status).toBe("VOID");
    expect(Number(oldRow!.amountUsed)).toBe(0);
    expect(await livePayments(old.id)).toHaveLength(0);
    expect((await prisma.invoice.findUnique({ where: { id: invPay } }))?.status).toBe("SENT");
    const blocks = await prisma.creditNoteApplyBlock.findMany({ where: { creditNoteId: old.id } });
    expect(blocks.map((b) => [b.invoiceId, b.reason])).toEqual([[invPay, "VOID_REVERSAL"]]);

    // The new note: ISSUED, unapplied, same customer and source invoice, prefixed reason.
    const fresh = await prisma.creditNote.findUnique({ where: { id: res.creditNote.id } });
    expect(fresh).toMatchObject({
      status: "ISSUED",
      customerId,
      invoiceId: invSrc,
      reason: `Replaces ${old.creditNoteNumber} — Price fix`,
    });
    expect(Number(fresh!.amount)).toBe(20);
    expect(Number(fresh!.amountUsed)).toBe(0);
    expect(await livePayments(fresh!.id)).toHaveLength(0);
    expect(res.unapplied).toEqual([expect.objectContaining({ invoiceId: invPay, amount: 30 })]);

    // Audit trail: VOIDED + SUPERSEDED on the old note, REISSUED on the new one.
    expect((await audits(tenantId, old.id)).map((a) => a.action).sort()).toEqual([
      "SUPERSEDED",
      "VOIDED",
    ]);
    const [reissued] = await audits(tenantId, fresh!.id);
    expect(reissued.action).toBe("REISSUED");
    expect(reissued.userId).toBe(actor);
    expect(reissued.meta).toMatchObject({ replaces: old.id, replacesNumber: old.creditNoteNumber });

    // Ledger: the old note's entries are counter-entered once, on the reissue's transaction.
    expect(mockLedger.unreverseCreditNoteEntries).toHaveBeenCalledTimes(1);
    expect(mockLedger.unreverseCreditNoteEntries).toHaveBeenCalledWith({
      creditNoteId: old.id,
      db: expect.anything(),
    });
  }, 60_000);

  it("2: a failure after the void rolls the whole reissue back", async () => {
    const { tenantId, customerId } = await seedTenant("rollback");
    const invSrc = await seedSentInvoice(tenantId, customerId, 50);
    const invPay = await seedSentInvoice(tenantId, customerId, 40);
    const old = await seedSourcedCredit(tenantId, customerId, invSrc, 30);
    await tenantCtx.run(tenantId, () => creditNotes.applyToInvoice(old.id, invPay, 30));
    const notesBefore = await prisma.creditNote.count({ where: { tenantId } });

    jest
      .spyOn(creditNotes, "insertCreditNoteInTx")
      .mockRejectedValueOnce(new Error("forced failure after the void"));

    await expect(run(tenantId, old.id, { amount: 20 }, "k-2")).rejects.toThrow(/forced failure/);

    const oldRow = await prisma.creditNote.findUnique({ where: { id: old.id } });
    expect(oldRow?.status).toBe("APPLIED");
    expect(Number(oldRow!.amountUsed)).toBe(30);
    expect(await livePayments(old.id)).toHaveLength(1);
    expect((await prisma.invoice.findUnique({ where: { id: invPay } }))?.status).toBe("PARTIAL");
    expect(
      await prisma.creditNoteApplyBlock.findMany({ where: { creditNoteId: old.id } }),
    ).toHaveLength(0);
    expect(await audits(tenantId, old.id)).toHaveLength(0);
    expect(await prisma.creditNote.count({ where: { tenantId } })).toBe(notesBefore);
  }, 60_000);

  it("3: headroom — equal to the freed headroom passes; above it is a 409 that burns no number", async () => {
    const { tenantId, customerId } = await seedTenant("headroom");
    const invSrc = await seedSentInvoice(tenantId, customerId, 50);
    const a = await seedSourcedCredit(tenantId, customerId, invSrc, 30);
    await seedSourcedCredit(tenantId, customerId, invSrc, 20); // the invoice is fully credited
    const before = await counter(tenantId);

    await expect(run(tenantId, a.id, { amount: 30.01 }, "k-3a")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect((await counter(tenantId))?.nextNumber).toBe(before?.nextNumber); // nothing reserved
    expect((await prisma.creditNote.findUnique({ where: { id: a.id } }))?.status).toBe("ISSUED");

    const ok = await run(tenantId, a.id, { amount: 30 }, "k-3b");
    expect(Number(ok.creditNote.amount)).toBe(30);
  }, 60_000);

  it("4: a live return-backed note is a 409 'Edit the return instead', zero writes", async () => {
    const { tenantId, customerId } = await seedTenant("return");
    const invSrc = await seedSentInvoice(tenantId, customerId, 50);
    const old = await seedSourcedCredit(tenantId, customerId, invSrc, 30);
    const order = await prisma.order.create({
      data: { tenantId, customerId, status: "PENDING", total: 30 },
    });
    await prisma.return.create({
      data: {
        tenantId,
        orderId: order.id,
        customerId,
        reason: "DAMAGED",
        status: "REFUNDED",
        creditNoteId: old.id,
      },
    });
    const before = await counter(tenantId);

    await expect(run(tenantId, old.id, { amount: 20 }, "k-4")).rejects.toThrow(
      /Edit the return instead/,
    );
    expect((await prisma.creditNote.findUnique({ where: { id: old.id } }))?.status).toBe("ISSUED");
    expect(await audits(tenantId, old.id)).toHaveLength(0);
    expect((await counter(tenantId))?.nextNumber).toBe(before?.nextNumber);
  }, 60_000);

  it("5: a replay returns the same new note (exactly one minted); a different body is a 409", async () => {
    const { tenantId, customerId } = await seedTenant("replay");
    const invSrc = await seedSentInvoice(tenantId, customerId, 50);
    const old = await seedSourcedCredit(tenantId, customerId, invSrc, 30);

    const first = await run(tenantId, old.id, { amount: 20 }, "k-5");
    const again = await run(tenantId, old.id, { amount: 20 }, "k-5");

    expect(again.creditNote.id).toBe(first.creditNote.id);
    const minted = await prisma.creditNote.findMany({
      where: { tenantId, reason: { startsWith: `Replaces ${old.creditNoteNumber}` } },
    });
    expect(minted).toHaveLength(1);
    await expect(run(tenantId, old.id, { amount: 25 }, "k-5")).rejects.toBeInstanceOf(
      ConflictException,
    );
  }, 60_000);
});
