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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { IdempotencyService } from "../common/idempotency.service";
import { AuditService } from "../audit/audit.service";
import { periodBucketOf } from "../regulated/period";
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
  let numbering: NumberingService;
  const tenantIds: string[] = [];
  const idemHashes: string[] = [];
  let seq = 0;

  const mockLedger = {
    reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
    unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
    reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined), // deleteInvoice (case 15)
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
        // InvoicesService and EstimatesService inject it (#2198/SA-397, flag.msrp); L-247: every
        // construction site of a class lists its constructor's providers.
        {
          provide: EntitlementAuthority,
          useValue: { can: jest.fn().mockResolvedValue(false) },
        },
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
      ],
    }).compile();
    invoices = mod.get(InvoicesService);
    creditNotes = mod.get(CreditNotesService);
    reissue = mod.get(CreditNoteReissueService);
    idempotency = mod.get(IdempotencyService);
    numbering = mod.get(NumberingService);
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

  /**
   * Holds every caller at `numbering.reserveNext` until `n` have arrived, then lets them all
   * through. Both callers have passed every PRE-tx refusal / replay / cap by then, so the race is
   * decided by the IN-tx re-checks (the lock, the Serializable conflict, the void's refusal, the
   * authoritative re-cap) and not by which request happened to finish first.
   */
  function barrierAtReserve(n: number) {
    const real = (numbering.reserveNext as any).bind(numbering);
    const waiting: Array<() => void> = [];
    return jest.spyOn(numbering, "reserveNext").mockImplementation((async (...args: any[]) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`barrier: fewer than ${n} callers reached reserveNext`)),
          20_000,
        );
        waiting.push(() => {
          clearTimeout(t);
          resolve();
        });
        if (waiting.length >= n) waiting.forEach((w) => w());
      });
      return real(...args);
    }) as any);
  }
  const settle = async (...calls: Array<Promise<any>>) => {
    const results = await Promise.allSettled(calls);
    return {
      ok: results.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled"),
      failed: results.filter((r): r is PromiseRejectedResult => r.status === "rejected"),
    };
  };
  const actionsOn = async (tenantId: string, id: string) =>
    (await audits(tenantId, id)).map((a) => a.action).sort();
  const IN_TX_LOSS = /already void|in progress|retry/i;

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

  it("7: SA-608 — an autoApplyExcluded old note's replacement is excluded too, so the sweep skips it", async () => {
    const { tenantId, customerId } = await seedTenant("excluded");
    const invSrc = await seedSentInvoice(tenantId, customerId, 50);
    const old = await seedSourcedCredit(tenantId, customerId, invSrc, 30);
    await prisma.creditNote.update({ where: { id: old.id }, data: { autoApplyExcluded: true } });

    const res = await run(tenantId, old.id, { amount: 20 }, "k-7");

    const fresh = await prisma.creditNote.findUnique({ where: { id: res.creditNote.id } });
    expect(fresh?.autoApplyExcluded).toBe(true);
  }, 60_000);

  it("8: SA-608 — two DIFFERENT keys racing on one source note (barriered past every pre-tx check): exactly one successor and one readable 409", async () => {
    const { tenantId, customerId } = await seedTenant("race");
    const invSrc = await seedSentInvoice(tenantId, customerId, 50);
    const old = await seedSourcedCredit(tenantId, customerId, invSrc, 30);
    const before = await counter(tenantId);
    barrierAtReserve(2);
    const voidSpy = jest.spyOn(creditNotes, "voidWithReversalInTx");

    const { ok, failed } = await settle(
      run(tenantId, old.id, { amount: 20 }, "k-8a"),
      run(tenantId, old.id, { amount: 25 }, "k-8b"),
    );

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(ConflictException);
    expect(String(failed[0].reason.message)).toMatch(IN_TX_LOSS); // the IN-tx refusal, not a pre-tx one
    expect(voidSpy.mock.calls.length).toBeGreaterThanOrEqual(2); // both really entered the void
    const successors = await prisma.creditNote.findMany({
      where: { tenantId, reason: { startsWith: `Replaces ${old.creditNoteNumber}` } },
    });
    expect(successors).toHaveLength(1);
    expect(await actionsOn(tenantId, old.id)).toEqual(["SUPERSEDED", "VOIDED"]); // one each
    expect((await counter(tenantId))?.nextNumber).toBe(before!.nextNumber + 2); // both reserved
  }, 60_000);

  describe("SA-608c: a note with no source invoice", () => {
    const orphan = async (label: string, amount: number, withLines = false) => {
      const { tenantId, customerId } = await seedTenant(label);
      const invSrc = await seedSentInvoice(tenantId, customerId, 600);
      const lineId = withLines
        ? (await prisma.invoiceItem.findFirst({ where: { invoiceId: invSrc } }))!.id
        : null;
      const cn = await tenantCtx.run(tenantId, () =>
        creditNotes.create({
          customerId,
          invoiceId: invSrc,
          amount,
          reason: "Damaged case",
          ...(lineId ? { items: [{ invoiceItemId: lineId, amount }] } : {}),
        } as any),
      );
      // What deleteInvoice does to a closed note: the link is nulled (items, if any, survive).
      await prisma.creditNote.update({ where: { id: cn.id }, data: { invoiceId: null } });
      return { tenantId, customerId, id: cn.id as string, number: cn.creditNoteNumber as string };
    };

    it("12: (a) a deleted source then an edit up to $500 is a 409 with zero writes; down to <= $50 passes", async () => {
      const o = await orphan("orph-a", 50);
      const before = await counter(o.tenantId);

      await expect(run(o.tenantId, o.id, { amount: 500 }, "k-12a")).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect((await prisma.creditNote.findUnique({ where: { id: o.id } }))?.status).toBe("ISSUED");
      expect(await audits(o.tenantId, o.id)).toHaveLength(0);
      expect((await counter(o.tenantId))?.nextNumber).toBe(before?.nextNumber);

      const ok = await run(o.tenantId, o.id, { amount: 50 }, "k-12b");
      expect(Number(ok.creditNote.amount)).toBe(50); // net value created: zero
      expect((await prisma.creditNote.findUnique({ where: { id: o.id } }))?.status).toBe("VOID");
    }, 60_000);

    it("13: (b) a line-bearing orphan is a 409 'source invoice was deleted', zero writes", async () => {
      const o = await orphan("orph-b", 50, true);
      const before = await counter(o.tenantId);

      await expect(run(o.tenantId, o.id, { amount: 10 }, "k-13")).rejects.toThrow(
        /source invoice was deleted/,
      );
      expect((await prisma.creditNote.findUnique({ where: { id: o.id } }))?.status).toBe("ISSUED");
      expect((await counter(o.tenantId))?.nextNumber).toBe(before?.nextNumber);
    }, 60_000);

    it("15: #2848 - deleting an invoice with 2 closed linked notes leaves 2 SOURCE_DELETED rows; reissue of either is a 409", async () => {
      const { tenantId, customerId } = await seedTenant("srcdel");
      const invSrc = await seedSentInvoice(tenantId, customerId, 50);
      const a = await seedSourcedCredit(tenantId, customerId, invSrc, 20);
      const b = await seedSourcedCredit(tenantId, customerId, invSrc, 20);
      // Closed = expired (deleteInvoice refuses while a sourced note still has spendable balance).
      await prisma.creditNote.updateMany({
        where: { id: { in: [a.id, b.id] } },
        data: { expiresAt: new Date("2020-01-01T00:00:00Z") },
      });

      await tenantCtx.run(tenantId, () => invoices.deleteInvoice(invSrc));

      const marks = await prisma.auditLog.findMany({
        where: { tenantId, entityType: "CreditNote", action: "SOURCE_DELETED" },
      });
      expect(marks.map((m) => m.entityId).sort()).toEqual([a.id, b.id].sort());
      expect(marks[0].meta).toMatchObject({ invoiceId: invSrc });
      expect((await prisma.creditNote.findUnique({ where: { id: a.id } }))?.invoiceId).toBeNull();

      const before = await counter(tenantId);
      for (const [n, key] of [
        [a, "k-15a"],
        [b, "k-15b"],
      ] as const) {
        // <= its own amount and a future expiry: SA-608c (a) alone would let this pass.
        await expect(
          run(tenantId, n.id, { amount: 10, expiresAt: "2999-01-01T00:00:00.000Z" }, key),
        ).rejects.toThrow(/source invoice was deleted/);
        expect((await prisma.creditNote.findUnique({ where: { id: n.id } }))?.status).toBe(
          "ISSUED",
        );
        await expect(
          tenantCtx.run(tenantId, () =>
            creditNotes.updateCreditNote(n.id, { expiresAt: "2999-01-01T00:00:00.000Z" }, null),
          ),
        ).rejects.toThrow(/source invoice was deleted/);
      }
      expect((await counter(tenantId))?.nextNumber).toBe(before?.nextNumber); // no number burned
    }, 60_000);

    it("14: a born-standalone note: down passes, up is a 409", async () => {
      const { tenantId, customerId } = await seedTenant("born");
      const cn = await tenantCtx.run(tenantId, () =>
        creditNotes.create({ customerId, amount: 40, reason: "Goodwill" } as any),
      );
      await expect(run(tenantId, cn.id, { amount: 41 }, "k-14a")).rejects.toBeInstanceOf(
        ConflictException,
      );
      const ok = await run(tenantId, cn.id, { amount: 25 }, "k-14b");
      expect(Number(ok.creditNote.amount)).toBe(25);
    }, 60_000);
  });

  it("9: two concurrent reissues, SAME key + SAME body (barriered): both return the same note, exactly one minted", async () => {
    const { tenantId, customerId } = await seedTenant("samekey");
    const invSrc = await seedSentInvoice(tenantId, customerId, 50);
    const old = await seedSourcedCredit(tenantId, customerId, invSrc, 30);
    const before = await counter(tenantId);
    barrierAtReserve(2);
    const voidSpy = jest.spyOn(creditNotes, "voidWithReversalInTx");

    const { ok, failed } = await settle(
      run(tenantId, old.id, { amount: 20 }, "k-9"),
      run(tenantId, old.id, { amount: 20 }, "k-9"),
    );

    expect(failed).toHaveLength(0);
    expect(ok[0].value.creditNote.id).toBe(ok[1].value.creditNote.id);
    expect(voidSpy.mock.calls.length).toBeGreaterThanOrEqual(2); // the loser's first attempt reached the void, then replayed
    const minted = await prisma.creditNote.findMany({
      where: { tenantId, reason: { startsWith: `Replaces ${old.creditNoteNumber}` } },
    });
    expect(minted).toHaveLength(1);
    expect(await actionsOn(tenantId, old.id)).toEqual(["SUPERSEDED", "VOIDED"]);
    expect((await counter(tenantId))?.nextNumber).toBe(before!.nextNumber + 2);
  }, 60_000);

  it("10: the race-loser (keys swapped vs case 8, barriered) is a readable in-tx 409, never a 500", async () => {
    const { tenantId, customerId } = await seedTenant("loser");
    const invSrc = await seedSentInvoice(tenantId, customerId, 50);
    const old = await seedSourcedCredit(tenantId, customerId, invSrc, 30);
    const before = await counter(tenantId);
    barrierAtReserve(2);
    const voidSpy = jest.spyOn(creditNotes, "voidWithReversalInTx");

    const { ok, failed } = await settle(
      run(tenantId, old.id, { amount: 25 }, "k-10b"),
      run(tenantId, old.id, { amount: 20 }, "k-10a"),
    );

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(ConflictException);
    expect((failed[0].reason as ConflictException).getStatus()).toBe(409);
    expect(String(failed[0].reason.message)).toMatch(IN_TX_LOSS);
    expect(voidSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(await actionsOn(tenantId, old.id)).toEqual(["SUPERSEDED", "VOIDED"]);
    expect((await counter(tenantId))?.nextNumber).toBe(before!.nextNumber + 2);
  }, 60_000);

  it("11: a reissue racing create() on the same source invoice (barriered; create() also reserves via numbering) never pushes total credit past the invoice total", async () => {
    const { tenantId, customerId } = await seedTenant("vscreate");
    const invSrc = await seedSentInvoice(tenantId, customerId, 50);
    const old = await seedSourcedCredit(tenantId, customerId, invSrc, 30);
    const before = await counter(tenantId);
    barrierAtReserve(2);
    const voidSpy = jest.spyOn(creditNotes, "voidWithReversalInTx");

    // Both pass their pre-tx cap (35 <= 50 with the old note excluded; 30 + 20 <= 50). Sequentially
    // either order refuses the second (35 + 20 > 50): only a write-skew would let both commit.
    const { ok, failed } = await settle(
      run(tenantId, old.id, { amount: 35 }, "k-11"),
      tenantCtx.run(tenantId, () =>
        creditNotes.create({ customerId, invoiceId: invSrc, amount: 20, reason: "Race" } as any),
      ),
    );

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const status = (failed[0].reason as { getStatus?: () => number }).getStatus?.();
    expect(status).toBeGreaterThanOrEqual(400); // a readable refusal, never a 500
    expect(status).toBeLessThan(500);
    expect(voidSpy).toHaveBeenCalled();
    const live = await prisma.creditNote.findMany({
      where: { tenantId, invoiceId: invSrc, status: { not: "VOID" } },
    });
    expect(live.reduce((t, c) => t + Number(c.amount), 0)).toBeLessThanOrEqual(50);
    expect((await counter(tenantId))?.nextNumber).toBe(before!.nextNumber + 2);
  }, 60_000);
});

/**
 * SA-535c/d: a regulated, line-linked reissue on the REAL regulated ledger. The lifted void keeps
 * #2536's shipped behaviour (unreverseCreditNoteEntries deletes the old note's REVERSAL rows;
 * the locked-period counter-entry is #2541's, for every void path), so today the net filing for
 * the period is exactly the new note's reversal. Also the executed proof of findOne's `items`.
 */
describeDb("#2648 regulated line-linked reissue on the real ledger (SA-535c/d)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let creditNotes: CreditNotesService;
  let reissue: CreditNoteReissueService;
  let idempotency: IdempotencyService;
  const tenantIds: string[] = [];
  const idemHashes: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        CreditNoteReissueService,
        IdempotencyService,
        NumberingService,
        RegulatedLedgerService,
        CommissionEngineService,
        AuditService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: RouteFlowGateway,
          useValue: { emitCreditNoteCreated: jest.fn(), emitCreditNoteVoided: jest.fn() },
        },
      ],
    }).compile();
    creditNotes = mod.get(CreditNotesService);
    reissue = mod.get(CreditNoteReissueService);
    idempotency = mod.get(IdempotencyService);
  });

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    if (idemHashes.length)
      await prisma.idempotencyKey
        .deleteMany({ where: { keyHash: { in: idemHashes } } })
        .catch(swallow);
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
      await prisma.creditNoteApplyBlock.deleteMany(where).catch(swallow);
      await prisma.creditNoteItem.deleteMany(where).catch(swallow);
      await prisma.creditNote.deleteMany(where).catch(swallow);
      await prisma.numberingSequence.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.trackedCategory.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  it("6: old REVERSAL rows deleted, new items + new REVERSAL rows written, net filing = the new amount", async () => {
    const slug = assertTestTenant(`qa-2648-${RUN}-reg`, "credit-note-reissue.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `#2648 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: "c reg", contactName: "c reg", tenantId },
    });
    const cat = await prisma.trackedCategory.create({
      data: { tenantId, name: "cat reg", taxType: "EXCISE_PER_UNIT", rate: 1 },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        invoiceNumber: `INV-2648-${RUN}-reg`,
        status: "SENT",
        subtotal: 50,
        taxAmount: 5,
        total: 55,
      },
    });
    const reg = await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        description: "regulated",
        qty: 5,
        unitPrice: 10,
        subtotal: 50,
        trackedCategoryId: cat.id,
        categoryTaxAmount: 5,
      },
    });
    const soldAt = new Date();
    await prisma.regulatedSalesLedger.create({
      data: {
        tenantId,
        trackedCategoryId: cat.id,
        entryType: "SALE",
        invoiceId: invoice.id,
        invoiceItemId: reg.id,
        qty: 5,
        unitBasisQty: 5,
        netSales: 50,
        categoryTax: 5,
        soldAt,
        periodBucket: periodBucketOf(soldAt),
      },
    });

    const old = await tenantCtx.run(tenantId, () =>
      creditNotes.create({
        customerId: customer.id,
        invoiceId: invoice.id,
        amount: 20,
        items: [{ invoiceItemId: reg.id, amount: 20 }],
      } as any),
    );
    const reversals = (creditNoteId?: string) =>
      prisma.regulatedSalesLedger.findMany({
        where: { tenantId, entryType: "REVERSAL", ...(creditNoteId ? { creditNoteId } : {}) },
      });
    const net = (rows: Array<{ netSales: unknown }>) =>
      Math.round(rows.reduce((t, r) => t + Math.abs(Number(r.netSales)), 0) * 100) / 100;
    expect(net(await reversals(old.id))).toBe(20);

    // findOne returns the line split the Edit form prefills (SA-535c, executed proof).
    const read = await tenantCtx.run(tenantId, () => creditNotes.findOne(old.id));
    expect(
      (read as any).items.map((i: any) => [i.invoiceItemId, Number(i.amount), Number(i.qty)]),
    ).toEqual([[reg.id, 20, 2]]);

    // A header-only reissue of a line-linked note is refused before anything is reserved.
    const key0 = "k-6a";
    idemHashes.push(idempotency.hashFor(key0, tenantId, `creditNoteReissue:${old.id}`));
    await expect(
      tenantCtx.run(tenantId, () => reissue.reissue(old.id, { amount: 30 }, key0, null)),
    ).rejects.toThrow(/give the new amount for each line/);
    expect(net(await reversals(old.id))).toBe(20);

    const key = "k-6b";
    idemHashes.push(idempotency.hashFor(key, tenantId, `creditNoteReissue:${old.id}`));
    const res = await tenantCtx.run(tenantId, () =>
      reissue.reissue(
        old.id,
        { amount: 30, items: [{ invoiceItemId: reg.id, amount: 30 }] },
        key,
        null,
      ),
    );

    expect(await reversals(old.id)).toHaveLength(0); // #2536 as shipped: deleted, not counter-entered
    const fresh = await reversals(res.creditNote.id);
    expect(net(fresh)).toBe(30);
    expect(net(await reversals())).toBe(30); // the period's net filing is the new amount's reversal
    const items = await prisma.creditNoteItem.findMany({
      where: { creditNoteId: res.creditNote.id },
    });
    expect(items.map((i) => [i.invoiceItemId, i.trackedCategoryId, Number(i.amount)])).toEqual([
      [reg.id, cat.id, 30],
    ]);
  }, 60_000);
});
