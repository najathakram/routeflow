/**
 * SA-436 / SA-436a (#2401) — real-Postgres proof of the credit-note auto-apply gate:
 *
 *  - `TenantConfig.creditAutoApplyOnSend` (OFF by default, no config row also reads OFF) gates
 *    ONLY the send-time oldest-first sweep (`autoApplyOldestCreditsInTx`); an order's hand-picked
 *    intent still settles at send regardless of the switch (`settleOrderCreditsInTx`).
 *  - `CreditNote.autoApplyExcluded` (`setAutoApplyExcluded`) skips a note in the sweep and is
 *    audited (`AuditLog` action `EXCLUDED`).
 *  - `CreditNoteApplyBlock` (`apply-block.ts`) is the shared don't-re-apply memory for a
 *    (credit note, invoice) pair: written by `unapplyFromInvoice` (UNAPPLIED) and by a dropped
 *    order intent in `syncOrderCreditSelections` (UNTICKED, one row per non-VOID invoice of the
 *    order); cleared by a manual `applyToInvoice` and by a re-ticked/re-amounted intent. While a
 *    block exists, neither the sweep nor `settleOrderCreditsInTx` re-applies that pair.
 *  - `InvoicePayment.autoApplied` distinguishes the sweep's own payments from every manual write.
 *
 * Real: PrismaService, TenantContextService, InvoicesService AND CreditNotesService (sharing one
 * Prisma client) — the real writers shape every money fixture (`invoices.send`, `creditNotes.
 * create`, `applyToInvoice`, `unapplyFromInvoice`, `setAutoApplyExcluded`, `syncOrderCreditSelections`
 * + `settleOrderCreditsInTx`, mirroring `orders.service.ts`'s own pairing around its line ~2200).
 * Stubbed collaborators are the same set every invoices/credit-notes DB spec stubs (gateway, email,
 * pdf, messaging, storage, entitlements, selling-restrictions, ledger, commission engine) — none of
 * which this file's money depends on.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js collects `*.db.spec.ts`, run via
 * `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api"`, RUN_DB_SPECS set,
 * DATABASE_URL pointed at the compose/dbspec Postgres). Every tenant is a throwaway
 * `qa-2401-<run>-<n>-<label>` slug approved by `assertTestTenant`; `afterAll` deletes exactly the
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
import { BadRequestException, NotFoundException } from "@nestjs/common";
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

describeDb("SA-436/SA-436a credit-note auto-apply gate, blocks and exclusions (#2401)", () => {
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
      `qa-2401-${RUN}-${seq}-${label}`,
      "credit-auto-apply-sa436.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `#2401 ${slug}` } });
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
        invoiceNumber: `INV-2401-${RUN}-${seq}`,
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

  it("1: OFF (no TenantConfig row) — sending sweeps NOTHING, but the order's hand-picked intent still settles", async () => {
    const { tenantId, customerId } = await seedTenant("p1", null);
    // $60 invoice: the $40 intent leaves $20 an ON sweep would fill from the unrelated $25 note.
    const invoiceId = await seedDraftInvoice(tenantId, customerId, 60);
    const order = await prisma.order.create({
      data: { tenantId, customerId, status: "PENDING", total: 60 },
    });
    await prisma.invoice.update({ where: { id: invoiceId }, data: { orderId: order.id } });

    const intentNoteId = await seedOpenCredit(tenantId, customerId, 40);
    const unrelatedNoteId = await seedOpenCredit(tenantId, customerId, 25);

    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx) => {
        await creditNotes.syncOrderCreditSelections(tx, order.id, customerId, [
          { creditNoteId: intentNoteId, amount: 40 },
        ]);
        await creditNotes.settleOrderCreditsInTx(tx, order.id);
      }),
    );

    await tenantCtx.run(tenantId, () => invoices.send(invoiceId, { allowPreDelivery: true }));

    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(inv?.status).toBe("PARTIAL"); // $40 of $60: the sweep did NOT top it up

    const intentNote = await prisma.creditNote.findUnique({ where: { id: intentNoteId } });
    expect(Number(intentNote!.amountUsed)).toBe(40);
    const unrelatedNote = await prisma.creditNote.findUnique({ where: { id: unrelatedNoteId } });
    expect(Number(unrelatedNote!.amountUsed)).toBe(0);
    expect(await activePaymentsFor(unrelatedNoteId)).toHaveLength(0);
  }, 30_000);

  it("2: OFF explicitly (creditAutoApplyOnSend: false) — the sweep still applies nothing", async () => {
    const { tenantId, customerId } = await seedTenant("p2", false);
    const invoiceId = await seedDraftInvoice(tenantId, customerId, 30);
    const unrelatedNoteId = await seedOpenCredit(tenantId, customerId, 15);

    await tenantCtx.run(tenantId, () => invoices.send(invoiceId, { allowPreDelivery: true }));

    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(inv?.status).toBe("SENT");
    const note = await prisma.creditNote.findUnique({ where: { id: unrelatedNoteId } });
    expect(Number(note!.amountUsed)).toBe(0);
  }, 30_000);

  it("3: ON — oldest-first exactly as before: $50 then $70, both autoApplied, PAID", async () => {
    const { tenantId, customerId } = await seedTenant("p3", true);
    const invoiceId = await seedDraftInvoice(tenantId, customerId, 120);
    const olderId = await seedOpenCredit(tenantId, customerId, 50, 10);
    const newerId = await seedOpenCredit(tenantId, customerId, 100, 5);

    await tenantCtx.run(tenantId, () => invoices.send(invoiceId, { allowPreDelivery: true }));

    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(inv?.status).toBe("PAID");

    const olderPays = await activePaymentsFor(olderId, invoiceId);
    const newerPays = await activePaymentsFor(newerId, invoiceId);
    expect(olderPays).toHaveLength(1);
    expect(Number(olderPays[0].amount)).toBe(50);
    expect(olderPays[0].autoApplied).toBe(true);
    expect(newerPays).toHaveLength(1);
    expect(Number(newerPays[0].amount)).toBe(70);
    expect(newerPays[0].autoApplied).toBe(true);

    const older = await prisma.creditNote.findUnique({ where: { id: olderId } });
    const newer = await prisma.creditNote.findUnique({ where: { id: newerId } });
    expect(Number(older!.amountUsed)).toBe(50);
    expect(older!.status).toBe("APPLIED");
    expect(Number(newer!.amountUsed)).toBe(70);
    expect(newer!.status).toBe("ISSUED");
  }, 30_000);

  it("4: ON + autoApplyExcluded on the older note — skipped by the sweep; newer note covers it; audited", async () => {
    const { tenantId, customerId } = await seedTenant("p4", true);
    const invoiceId = await seedDraftInvoice(tenantId, customerId, 60);
    const olderId = await seedOpenCredit(tenantId, customerId, 50, 10);
    const newerId = await seedOpenCredit(tenantId, customerId, 100, 5);
    const actorId = randomUUID();

    await tenantCtx.run(tenantId, () => creditNotes.setAutoApplyExcluded(olderId, true, actorId));

    await tenantCtx.run(tenantId, () => invoices.send(invoiceId, { allowPreDelivery: true }));

    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(inv?.status).toBe("PAID");
    expect(await activePaymentsFor(olderId, invoiceId)).toHaveLength(0);
    const newerPays = await activePaymentsFor(newerId, invoiceId);
    expect(newerPays).toHaveLength(1);
    expect(Number(newerPays[0].amount)).toBe(60);

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId, entityType: "CreditNote", action: "EXCLUDED", entityId: olderId },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBe(actorId);
  }, 30_000);

  it("5: ON + a blocked pair (unapply) — the sweep skips that pair on re-send", async () => {
    // Sent with the switch OFF (so the first send sweeps nothing), then paid by hand.
    const { tenantId, customerId } = await seedTenant("p5", false);
    const invoiceId = await seedDraftInvoice(tenantId, customerId, 50);
    const noteId = await seedOpenCredit(tenantId, customerId, 50);
    await tenantCtx.run(tenantId, () => invoices.send(invoiceId, { allowPreDelivery: true }));
    expect(await activePaymentsFor(noteId, invoiceId)).toHaveLength(0);

    await tenantCtx.run(tenantId, () => creditNotes.applyToInvoice(noteId, invoiceId));
    let inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(inv?.status).toBe("PAID");

    const actorId = randomUUID();
    await tenantCtx.run(tenantId, () => creditNotes.unapplyFromInvoice(noteId, invoiceId, actorId));
    const blocks = await blocksFor(noteId);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].reason).toBe("UNAPPLIED");
    expect(blocks[0].createdById).toBe(actorId);

    inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(inv?.status).toBe("SENT"); // no payment left after the unapply

    // The tenant turns the sweep ON; the re-send must still skip the blocked pair.
    await prisma.tenantConfig.update({
      where: { tenantId },
      data: { creditAutoApplyOnSend: true },
    });
    await tenantCtx.run(tenantId, () => invoices.send(invoiceId, { allowPreDelivery: true }));
    expect(await activePaymentsFor(noteId, invoiceId)).toHaveLength(0);
    const note = await prisma.creditNote.findUnique({ where: { id: noteId } });
    expect(Number(note!.amountUsed)).toBe(0);
  }, 30_000);

  it("6: a blocked pair is skipped by SETTLE too — an intent's own block stops the apply pass", async () => {
    // A $60 intent on a $40 invoice settles $40; unapplying it shrinks the intent to $20 (it
    // survives) and blocks the pair. A later settle must not put the $20 back on that invoice.
    // (Re-ticking would be explicit intent and clear the block — pin 10 — so none happens here.)
    const { tenantId, customerId } = await seedTenant("p6", true);
    const invoiceId = await seedDraftInvoice(tenantId, customerId, 40);
    const order = await prisma.order.create({
      data: { tenantId, customerId, status: "PENDING", total: 40 },
    });
    await prisma.invoice.update({ where: { id: invoiceId }, data: { orderId: order.id } });
    const noteId = await seedOpenCredit(tenantId, customerId, 60);

    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx) => {
        await creditNotes.syncOrderCreditSelections(tx, order.id, customerId, [
          { creditNoteId: noteId, amount: 60 },
        ]);
        await creditNotes.settleOrderCreditsInTx(tx, order.id);
      }),
    );
    expect(roundSum(await activePaymentsFor(noteId, invoiceId))).toBe(40);
    await tenantCtx.run(tenantId, () =>
      creditNotes.unapplyFromInvoice(noteId, invoiceId, randomUUID()),
    );
    expect(await blocksFor(noteId)).toHaveLength(1);
    const link = await prisma.orderCreditNote.findFirst({ where: { orderId: order.id } });
    expect(Number(link!.amount)).toBe(20); // the intent survives, shrunk

    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction((tx) => creditNotes.settleOrderCreditsInTx(tx, order.id)),
    );

    expect(await activePaymentsFor(noteId, invoiceId)).toHaveLength(0);
    expect(await blocksFor(noteId)).toHaveLength(1);
    const note = await prisma.creditNote.findUnique({ where: { id: noteId } });
    expect(Number(note!.amountUsed)).toBe(0);
  }, 30_000);

  it("7: a manual applyToInvoice clears the block — the new payment is autoApplied:false", async () => {
    const { tenantId, customerId } = await seedTenant("p7", true);
    const invoiceId = await seedDraftInvoice(tenantId, customerId, 40);
    const noteId = await seedOpenCredit(tenantId, customerId, 40);

    await tenantCtx.run(tenantId, () => creditNotes.applyToInvoice(noteId, invoiceId));
    await tenantCtx.run(tenantId, () =>
      creditNotes.unapplyFromInvoice(noteId, invoiceId, randomUUID()),
    );
    expect(await blocksFor(noteId)).toHaveLength(1);

    await tenantCtx.run(tenantId, () => creditNotes.applyToInvoice(noteId, invoiceId));

    expect(await blocksFor(noteId)).toHaveLength(0);
    const pays = await activePaymentsFor(noteId, invoiceId);
    expect(pays).toHaveLength(1);
    expect(pays[0].autoApplied).toBe(false);
  }, 30_000);

  it("8: SA-436a re-amount — settle at 40, re-amount to 25, resettle: pair sums to 25, no blocks", async () => {
    const { tenantId, customerId } = await seedTenant("p8", true);
    const invoiceId = await seedDraftInvoice(tenantId, customerId, 100);
    const order = await prisma.order.create({
      data: { tenantId, customerId, status: "PENDING", total: 100 },
    });
    await prisma.invoice.update({ where: { id: invoiceId }, data: { orderId: order.id } });
    const noteId = await seedOpenCredit(tenantId, customerId, 100);

    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx) => {
        await creditNotes.syncOrderCreditSelections(tx, order.id, customerId, [
          { creditNoteId: noteId, amount: 40 },
        ]);
        await creditNotes.settleOrderCreditsInTx(tx, order.id);
      }),
    );
    expect(roundSum(await activePaymentsFor(noteId, invoiceId))).toBe(40);

    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx) => {
        await creditNotes.syncOrderCreditSelections(tx, order.id, customerId, [
          { creditNoteId: noteId, amount: 25 },
        ]);
        await creditNotes.settleOrderCreditsInTx(tx, order.id);
      }),
    );

    expect(roundSum(await activePaymentsFor(noteId, invoiceId))).toBe(25);
    expect(await blocksFor(noteId)).toHaveLength(0);
  }, 30_000);

  it("9: SA-436a untick blocks BOTH sweep and settle — dropped intent stops re-application even with the switch ON", async () => {
    const { tenantId, customerId } = await seedTenant("p9", true);
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
    expect(roundSum(await activePaymentsFor(noteId, invoiceId))).toBe(40);

    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx) => {
        await creditNotes.syncOrderCreditSelections(tx, order.id, customerId, []);
        await creditNotes.settleOrderCreditsInTx(tx, order.id);
      }),
    );
    expect(await activePaymentsFor(noteId, invoiceId)).toHaveLength(0);
    const blocks = await blocksFor(noteId);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].reason).toBe("UNTICKED");

    await tenantCtx.run(tenantId, () => invoices.send(invoiceId, { allowPreDelivery: true }));
    expect(await activePaymentsFor(noteId, invoiceId)).toHaveLength(0);
    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(inv?.status).not.toBe("PAID");
  }, 30_000);

  it("10: SA-436a untick then re-tick re-applies and clears the block", async () => {
    const { tenantId, customerId } = await seedTenant("p10", true);
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
    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx) => {
        await creditNotes.syncOrderCreditSelections(tx, order.id, customerId, []);
        await creditNotes.settleOrderCreditsInTx(tx, order.id);
      }),
    );
    expect(await blocksFor(noteId)).toHaveLength(1);

    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx) => {
        await creditNotes.syncOrderCreditSelections(tx, order.id, customerId, [
          { creditNoteId: noteId, amount: 40 },
        ]);
        await creditNotes.settleOrderCreditsInTx(tx, order.id);
      }),
    );

    expect(roundSum(await activePaymentsFor(noteId, invoiceId))).toBe(40);
    expect(await blocksFor(noteId)).toHaveLength(0);
  }, 30_000);

  it("11: a dropped intent on an order with TWO non-VOID invoices (+ one VOID) writes exactly 2 UNTICKED blocks", async () => {
    const { tenantId, customerId } = await seedTenant("p11", true);
    const order = await prisma.order.create({
      data: { tenantId, customerId, status: "PENDING", total: 80 },
    });
    const invA = await seedDraftInvoice(tenantId, customerId, 40);
    const invB = await seedDraftInvoice(tenantId, customerId, 40);
    const invVoid = await seedDraftInvoice(tenantId, customerId, 40);
    await prisma.invoice.update({ where: { id: invA }, data: { orderId: order.id } });
    await prisma.invoice.update({ where: { id: invB }, data: { orderId: order.id } });
    await prisma.invoice.update({
      where: { id: invVoid },
      data: { orderId: order.id, status: "VOID" },
    });
    const noteId = await seedOpenCredit(tenantId, customerId, 100);

    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx) => {
        await creditNotes.syncOrderCreditSelections(tx, order.id, customerId, [
          { creditNoteId: noteId, amount: 80 },
        ]);
        await creditNotes.settleOrderCreditsInTx(tx, order.id);
      }),
    );
    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx) => {
        await creditNotes.syncOrderCreditSelections(tx, order.id, customerId, []);
        await creditNotes.settleOrderCreditsInTx(tx, order.id);
      }),
    );

    const blocks = await blocksFor(noteId);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.reason === "UNTICKED")).toBe(true);
    const blockedInvoiceIds = blocks.map((b) => b.invoiceId).sort();
    expect(blockedInvoiceIds).toEqual([invA, invB].sort());
    expect(blockedInvoiceIds).not.toContain(invVoid);
  }, 30_000);

  it("12: every refusal writes nothing — setAutoApplyExcluded on a missing id 404s, no AuditLog", async () => {
    const { tenantId } = await seedTenant("p12", true);
    const missingId = randomUUID();

    let err: any;
    try {
      await tenantCtx.run(tenantId, () =>
        creditNotes.setAutoApplyExcluded(missingId, true, randomUUID()),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotFoundException);

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId, action: "EXCLUDED", entityId: missingId },
    });
    expect(audit).toBeNull();
  }, 30_000);

  it("13: a FOREIGN tenant's note id ⇒ 404 on the exclusion PATCH, and nothing is written", async () => {
    const owner = await seedTenant("p13-owner", true);
    const other = await seedTenant("p13-other", true);
    const noteId = await seedOpenCredit(owner.tenantId, owner.customerId, 20);

    let err: any;
    try {
      await tenantCtx.run(other.tenantId, () =>
        creditNotes.setAutoApplyExcluded(noteId, true, randomUUID()),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotFoundException);

    const note = await prisma.creditNote.findUnique({ where: { id: noteId } });
    expect(note?.autoApplyExcluded).toBe(false);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "EXCLUDED", entityId: noteId },
    });
    expect(audit).toBeNull();
  }, 30_000);

  function roundSum(pays: Array<{ amount: unknown }>): number {
    return Math.round(pays.reduce((s, p) => s + Number(p.amount), 0) * 100) / 100;
  }
});
