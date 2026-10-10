/**
 * SA-436 PR-2 (#2402) — real-Postgres proof of void-with-reversal:
 *
 *  - `voidPreview(id)` (read-only): the invoices a reversal would reopen (amount, status
 *    before/after), `restoresTotal`, and the SAME refusal text `voidWithReversal` itself would
 *    return — without writing anything.
 *  - `voidWithReversal(id, actorId)`: un-applies every live (non-VOID) `CREDIT_NOTE` payment of
 *    the note via `restoreCreditFromPaymentInTx` (each invoice's status is recomputed from its
 *    remaining payments), writes one `CreditNoteApplyBlock` (reason `VOID_REVERSAL`, `createdById`
 *    = actor) per reopened invoice, deletes the note's `OrderCreditNote` rows, compare-and-set
 *    voids the note, calls `RegulatedLedgerService.unreverseCreditNoteEntries`, and writes one
 *    `AuditLog` (`entityType` `CreditNote`, `action` `VOIDED`, `userId` = actor).
 *  - `voidWithReversalRefusal` (shared by both): refuses BEFORE any write when the note is
 *    already VOID, when it backs a live (non-CANCELLED/REJECTED) `Return`, or when `amountUsed`
 *    exceeds what its live payments account for (`RETURN_CREDIT_CONSUMED`).
 *
 * Real: PrismaService, TenantContextService, InvoicesService AND CreditNotesService (sharing one
 * Prisma client) — the real writers shape every money fixture (`invoices.send`, `creditNotes.
 * create`, `applyToInvoice`, `syncOrderCreditSelections` + `settleOrderCreditsInTx`). Stubbed
 * collaborators are the same set every credit-notes DB spec stubs (gateway, email, pdf,
 * messaging, storage, entitlements, selling-restrictions, commission engine); `RegulatedLedgerService`
 * stays a mock so its `unreverseCreditNoteEntries` jest.fn can be asserted on directly.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js collects `*.db.spec.ts`, run via
 * `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api"`, RUN_DB_SPECS set,
 * DATABASE_URL pointed at the compose/dbspec Postgres). Every tenant is a throwaway
 * `qa-2402-<run>-<n>-<label>` slug approved by `assertTestTenant`; `afterAll` deletes exactly the
 * tenants this run created, in FK order. No client identifiers anywhere.
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
import { BadRequestException } from "@nestjs/common";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { CreditNotesService } from "./credit-notes.service";
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

describeDb("SA-436 PR-2 credit-note void-with-reversal (#2402)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  let creditNotes: CreditNotesService;
  const tenantIds: string[] = [];
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

  afterEach(() => {
    mockLedger.reverseCreditNoteEntries.mockClear();
    mockLedger.unreverseCreditNoteEntries.mockClear();
  });

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.return.deleteMany(where).catch(swallow);
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

  /** A fresh tenant with one customer (creditAutoApplyOnSend left OFF/default). */
  async function seedTenant(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-2402-${RUN}-${seq}-${label}`,
      "credit-note-void-reversal.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `#2402 ${slug}` } });
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

  /** A DRAFT invoice with one goods line, ready to `invoices.send`. */
  async function seedDraftInvoice(tenantId: string, customerId: string, total: number) {
    seq += 1;
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-2402-${RUN}-${seq}`,
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

  /** A minted, ISSUED, standalone open credit note via the REAL create() path. */
  async function seedOpenCredit(tenantId: string, customerId: string, amount: number) {
    const cn = await tenantCtx.run(tenantId, () =>
      creditNotes.create({ customerId, amount } as any),
    );
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

  it("1: reopens each invoice with the right status, blocks both pairs, audits, unreverses once", async () => {
    const { tenantId, customerId } = await seedTenant("p1");
    const invA = await seedDraftInvoice(tenantId, customerId, 40);
    const invB = await seedDraftInvoice(tenantId, customerId, 50);
    await tenantCtx.run(tenantId, () => invoices.send(invA, { allowPreDelivery: true }));
    await tenantCtx.run(tenantId, () => invoices.send(invB, { allowPreDelivery: true }));

    const noteId = await seedOpenCredit(tenantId, customerId, 60);
    await tenantCtx.run(tenantId, () => creditNotes.applyToInvoice(noteId, invA, 40));
    await tenantCtx.run(tenantId, () => creditNotes.applyToInvoice(noteId, invB, 20));

    let a = await prisma.invoice.findUnique({ where: { id: invA } });
    let b = await prisma.invoice.findUnique({ where: { id: invB } });
    expect(a?.status).toBe("PAID");
    expect(b?.status).toBe("PARTIAL");

    const actorId = randomUUID();
    const result = await tenantCtx.run(tenantId, () =>
      creditNotes.voidWithReversal(noteId, actorId),
    );

    a = await prisma.invoice.findUnique({ where: { id: invA } });
    b = await prisma.invoice.findUnique({ where: { id: invB } });
    expect(a?.status).toBe("SENT");
    expect(b?.status).toBe("SENT");
    expect(await activePaymentsFor(noteId, invA)).toHaveLength(0);
    expect(await activePaymentsFor(noteId, invB)).toHaveLength(0);

    const note = await prisma.creditNote.findUnique({ where: { id: noteId } });
    expect(note?.status).toBe("VOID");
    expect(Number(note!.amountUsed)).toBe(0);

    const blocks = await blocksFor(noteId);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((bl) => bl.reason === "VOID_REVERSAL")).toBe(true);
    expect(blocks.every((bl) => bl.createdById === actorId)).toBe(true);
    expect(blocks.every((bl) => bl.tenantId === tenantId)).toBe(true); // SA-436b
    expect(blocks.map((bl) => bl.invoiceId).sort()).toEqual([invA, invB].sort());

    const audits = await prisma.auditLog.findMany({
      where: { tenantId, entityType: "CreditNote", action: "VOIDED", entityId: noteId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(actorId);

    expect(mockLedger.unreverseCreditNoteEntries).toHaveBeenCalledTimes(1);
    expect(mockLedger.unreverseCreditNoteEntries).toHaveBeenCalledWith({
      creditNoteId: noteId,
      db: expect.anything(),
    });

    const reopened = result.reopened as Array<{ invoiceId: string; amount: number }>;
    expect(reopened).toHaveLength(2);
    expect(Number(reopened.find((r) => r.invoiceId === invA)!.amount)).toBe(40);
    expect(Number(reopened.find((r) => r.invoiceId === invB)!.amount)).toBe(20);
  }, 30_000);

  it("2: voidPreview reports the same reopen plan before any write happens", async () => {
    const { tenantId, customerId } = await seedTenant("p2");
    const invA = await seedDraftInvoice(tenantId, customerId, 40);
    const invB = await seedDraftInvoice(tenantId, customerId, 50);
    await tenantCtx.run(tenantId, () => invoices.send(invA, { allowPreDelivery: true }));
    await tenantCtx.run(tenantId, () => invoices.send(invB, { allowPreDelivery: true }));

    const noteId = await seedOpenCredit(tenantId, customerId, 60);
    await tenantCtx.run(tenantId, () => creditNotes.applyToInvoice(noteId, invA, 40));
    await tenantCtx.run(tenantId, () => creditNotes.applyToInvoice(noteId, invB, 20));

    const preview = await tenantCtx.run(tenantId, () => creditNotes.voidPreview(noteId));

    expect(preview.refusal).toBeNull();
    expect(preview.restoresTotal).toBe(60);
    const byInvoice = new Map(preview.invoices.map((i: any) => [i.invoiceId, i]));
    const a = byInvoice.get(invA) as any;
    const b = byInvoice.get(invB) as any;
    expect(a.amount).toBe(40);
    expect(a.statusBefore).toBe("PAID");
    expect(a.statusAfter).toBe("SENT");
    expect(b.amount).toBe(20);
    expect(b.statusBefore).toBe("PARTIAL");
    expect(b.statusAfter).toBe("SENT");

    // Nothing was written.
    expect(await activePaymentsFor(noteId, invA)).toHaveLength(1);
    expect(await activePaymentsFor(noteId, invB)).toHaveLength(1);
    const note = await prisma.creditNote.findUnique({ where: { id: noteId } });
    expect(note?.status).toBe("APPLIED");
  }, 30_000);

  it("3: the note's order intent is removed — 0 OrderCreditNote rows, invoice's credit payment gone", async () => {
    const { tenantId, customerId } = await seedTenant("p3");
    const invoiceId = await seedDraftInvoice(tenantId, customerId, 40);
    const order = await prisma.order.create({
      data: { tenantId, customerId, status: "PENDING", total: 40 },
    });
    await prisma.invoice.update({ where: { id: invoiceId }, data: { orderId: order.id } });
    const noteId = await seedOpenCredit(tenantId, customerId, 40);

    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx) => {
        await creditNotes.syncOrderCreditSelections(tx, order.id, customerId, [
          { creditNoteId: noteId, amount: 40 },
        ]);
        await creditNotes.settleOrderCreditsInTx(tx, order.id);
      }),
    );
    expect(await activePaymentsFor(noteId, invoiceId)).toHaveLength(1);
    expect(
      await prisma.orderCreditNote.findFirst({ where: { creditNoteId: noteId } }),
    ).not.toBeNull();

    await tenantCtx.run(tenantId, () => creditNotes.voidWithReversal(noteId, randomUUID()));

    expect(await prisma.orderCreditNote.findMany({ where: { creditNoteId: noteId } })).toHaveLength(
      0,
    );
    expect(await activePaymentsFor(noteId, invoiceId)).toHaveLength(0);
  }, 30_000);

  it("4: an unused note voids cleanly — no block rows, unreverse called", async () => {
    const { tenantId, customerId } = await seedTenant("p4");
    const noteId = await seedOpenCredit(tenantId, customerId, 25);

    const result = await tenantCtx.run(tenantId, () =>
      creditNotes.voidWithReversal(noteId, randomUUID()),
    );

    expect(result.creditNote.status).toBe("VOID");
    expect(result.reopened).toHaveLength(0);
    expect(await blocksFor(noteId)).toHaveLength(0);
    expect(mockLedger.unreverseCreditNoteEntries).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("5: already-VOID refuses — a second call adds no AuditLog and no block rows", async () => {
    const { tenantId, customerId } = await seedTenant("p5");
    const noteId = await seedOpenCredit(tenantId, customerId, 25);
    const actorId = randomUUID();

    await tenantCtx.run(tenantId, () => creditNotes.voidWithReversal(noteId, actorId));
    mockLedger.unreverseCreditNoteEntries.mockClear();

    await expect(
      tenantCtx.run(tenantId, () => creditNotes.voidWithReversal(noteId, actorId)),
    ).rejects.toBeInstanceOf(BadRequestException);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId, entityType: "CreditNote", action: "VOIDED", entityId: noteId },
    });
    expect(audits).toHaveLength(1); // only the first call's row
    expect(await blocksFor(noteId)).toHaveLength(0);
    expect(mockLedger.unreverseCreditNoteEntries).not.toHaveBeenCalled();
  }, 30_000);

  it("6: backs a live return — refuses with 'Cancel the return', zero writes", async () => {
    const { tenantId, customerId } = await seedTenant("p6");
    const noteId = await seedOpenCredit(tenantId, customerId, 30);
    const order = await prisma.order.create({
      data: { tenantId, customerId, status: "PENDING", total: 30 },
    });
    await prisma.return.create({
      data: {
        tenantId,
        orderId: order.id,
        customerId,
        reason: "DAMAGED",
        status: "RECEIVED",
        creditNoteId: noteId,
      },
    });

    await expect(
      tenantCtx.run(tenantId, () => creditNotes.voidWithReversal(noteId, randomUUID())),
    ).rejects.toThrow(/Cancel the return/);

    const note = await prisma.creditNote.findUnique({ where: { id: noteId } });
    expect(note?.status).toBe("ISSUED");
    expect(Number(note!.amountUsed)).toBe(0);
    expect(await activePaymentsFor(noteId)).toHaveLength(0);
    expect(await blocksFor(noteId)).toHaveLength(0);
    const audits = await prisma.auditLog.findMany({
      where: { tenantId, entityType: "CreditNote", action: "VOIDED", entityId: noteId },
    });
    expect(audits).toHaveLength(0);
    expect(mockLedger.unreverseCreditNoteEntries).not.toHaveBeenCalled();
  }, 30_000);

  it("7: consumed beyond its applications refuses RETURN_CREDIT_CONSUMED, zero writes; preview matches", async () => {
    const { tenantId, customerId } = await seedTenant("p7");
    const noteId = await seedOpenCredit(tenantId, customerId, 30);
    // The documented corruption case: amountUsed set above what any live payment accounts for.
    await prisma.creditNote.update({ where: { id: noteId }, data: { amountUsed: 10 } });

    await expect(
      tenantCtx.run(tenantId, () => creditNotes.voidWithReversal(noteId, randomUUID())),
    ).rejects.toThrow(/RETURN_CREDIT_CONSUMED/);

    const note = await prisma.creditNote.findUnique({ where: { id: noteId } });
    expect(note?.status).not.toBe("VOID");
    expect(Number(note!.amountUsed)).toBe(10);
    expect(await activePaymentsFor(noteId)).toHaveLength(0);
    expect(await blocksFor(noteId)).toHaveLength(0);
    const audits = await prisma.auditLog.findMany({
      where: { tenantId, entityType: "CreditNote", action: "VOIDED", entityId: noteId },
    });
    expect(audits).toHaveLength(0);
    expect(mockLedger.unreverseCreditNoteEntries).not.toHaveBeenCalled();

    const preview = await tenantCtx.run(tenantId, () => creditNotes.voidPreview(noteId));
    expect(preview.refusal).toMatch(/RETURN_CREDIT_CONSUMED/);
  }, 30_000);

  it("8: a CANCELLED return does not block — the void succeeds", async () => {
    const { tenantId, customerId } = await seedTenant("p8");
    const noteId = await seedOpenCredit(tenantId, customerId, 30);
    const order = await prisma.order.create({
      data: { tenantId, customerId, status: "PENDING", total: 30 },
    });
    await prisma.return.create({
      data: {
        tenantId,
        orderId: order.id,
        customerId,
        reason: "DAMAGED",
        status: "CANCELLED",
        creditNoteId: noteId,
      },
    });

    const result = await tenantCtx.run(tenantId, () =>
      creditNotes.voidWithReversal(noteId, randomUUID()),
    );

    expect(result.creditNote.status).toBe("VOID");
  }, 30_000);
});
