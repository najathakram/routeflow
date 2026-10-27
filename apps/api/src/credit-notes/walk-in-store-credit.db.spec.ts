/**
 * W-913 (SA-932 §A, §B; red cases 2, 3 and 5), real Postgres:
 *  - the send-time sweep never takes a credit note off the walk-in account (a legacy open credit stays unapplied, whatever
 *    `creditAutoApplyOnSend` says) while a named customer's credit is applied exactly as before;
 *  - every credit-note writer refuses the walk-in customer with 409 WALK_IN_STORE_CREDIT_REFUSED and writes no row: the
 *    manual credit note (create), the inline capture's mint (mintStandaloneInTx) and the reissue of a legacy walk-in note
 *    (which also leaves the old note un-voided: the refusal rolls the whole reissue back).
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-w913-<run>-<n>-<label>` slug approved by
 * `assertTestTenant`; `afterAll` deletes exactly the tenants this run created. No client identifiers anywhere.
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
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

const refusalOf = async (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => null,
    (e: any) => ({ status: e?.getStatus?.(), ...(e?.getResponse?.() ?? { name: e?.name }) }),
  );

describeDb("W-913 no store credit on the walk-in account", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  let creditNotes: CreditNotesService;
  let reissue: CreditNoteReissueService;
  let numbering: NumberingService;
  let idempotency: IdempotencyService;
  const tenantIds: string[] = [];
  const idemHashes: string[] = [];
  let seq = 0;

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
        AuditService,
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
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
            unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
            reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined),
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
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
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
    reissue = mod.get(CreditNoteReissueService);
    numbering = mod.get(NumberingService);
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
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /** A fresh tenant with the sweep ON, one walk-in customer and one named customer. */
  async function seedTenant(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-w913-${RUN}-${seq}-${label}`,
      "walk-in-store-credit.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `W-913 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    await prisma.tenantConfig.create({ data: { tenantId, creditAutoApplyOnSend: true } });
    const mk = async (kind: string, isWalkIn: boolean | null) => {
      const user = await prisma.user.create({
        data: {
          email: `${kind}-${slug}@example.invalid`,
          username: `${kind}-${slug}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      const c = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: `${kind} ${label}`,
          contactName: kind,
          tenantId,
          isWalkIn,
        },
      });
      return c.id as string;
    };
    return { tenantId, walkInId: await mk("walkin", true), namedId: await mk("named", null) };
  }

  async function seedDraftInvoice(tenantId: string, customerId: string, total: number) {
    seq += 1;
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-W913-${RUN}-${seq}`,
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

  /** A credit note written straight to the table: the shape a legacy walk-in credit already has. */
  async function legacyCredit(tenantId: string, customerId: string, amount: number) {
    seq += 1;
    const cn = await prisma.creditNote.create({
      data: {
        tenantId,
        creditNoteNumber: `CN-W913-${RUN}-${seq}`,
        customerId,
        invoiceId: null,
        amount,
        status: "ISSUED",
      },
    });
    return cn.id as string;
  }

  const notesOf = (customerId: string) => prisma.creditNote.findMany({ where: { customerId } });

  it("red case 2: a legacy open credit on the walk-in account is never swept onto a walk-in invoice (auto-apply ON)", async () => {
    const { tenantId, walkInId } = await seedTenant("sweep");
    const creditId = await legacyCredit(tenantId, walkInId, 20);
    const invoiceId = await seedDraftInvoice(tenantId, walkInId, 30);

    await tenantCtx.run(tenantId, () => invoices.send(invoiceId, { allowPreDelivery: true }));

    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(inv?.status).toBe("SENT"); // not PARTIAL: nothing was applied
    const note = await prisma.creditNote.findUnique({ where: { id: creditId } });
    expect(Number(note!.amountUsed)).toBe(0);
    expect(note!.status).toBe("ISSUED");
    expect(await prisma.invoicePayment.count({ where: { creditNoteId: creditId } })).toBe(0);
  }, 30_000);

  it("red case 5: a named customer's open credit is swept exactly as before", async () => {
    const { tenantId, namedId } = await seedTenant("named");
    const creditId = await legacyCredit(tenantId, namedId, 20);
    const invoiceId = await seedDraftInvoice(tenantId, namedId, 30);

    await tenantCtx.run(tenantId, () => invoices.send(invoiceId, { allowPreDelivery: true }));

    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(inv?.status).toBe("PARTIAL");
    const note = await prisma.creditNote.findUnique({ where: { id: creditId } });
    expect(Number(note!.amountUsed)).toBe(20);
  }, 30_000);

  it("red case 3a: a manual credit note on the walk-in customer is 409 and writes no row", async () => {
    const { tenantId, walkInId } = await seedTenant("manual");
    const body = await refusalOf(
      tenantCtx.run(tenantId, () =>
        creditNotes.create({ customerId: walkInId, amount: 15 } as any),
      ),
    );
    expect(body).toMatchObject({ status: 409, code: "WALK_IN_STORE_CREDIT_REFUSED" });
    expect(await notesOf(walkInId)).toHaveLength(0);
  }, 30_000);

  it("red case 1/3: the inline capture's mint on the walk-in customer is 409 and writes no row", async () => {
    const { tenantId, walkInId } = await seedTenant("mint");
    const body = await refusalOf(
      tenantCtx.run(tenantId, async () => {
        const number = await numbering.reserveNext("CREDIT_NOTE", { year: 2026, tenantId });
        return prisma.tenantTransaction((tx: any) =>
          creditNotes.mintStandaloneInTx(
            tx,
            { customerId: walkInId, amount: 15 },
            number,
            tenantId,
          ),
        );
      }),
    );
    expect(body).toMatchObject({ status: 409, code: "WALK_IN_STORE_CREDIT_REFUSED" });
    expect(await notesOf(walkInId)).toHaveLength(0);
  }, 30_000);

  it("red case 3c: a reissue of a legacy walk-in note is 409; the old note stays as it was and no replacement exists", async () => {
    const { tenantId, walkInId } = await seedTenant("reissue");
    const oldId = await legacyCredit(tenantId, walkInId, 20);
    const key = `w913-${RUN}-reissue`;
    idemHashes.push(idempotency.hashFor(key, tenantId, `creditNoteReissue:${oldId}`));

    const body = await refusalOf(
      tenantCtx.run(tenantId, () => reissue.reissue(oldId, { amount: 10 }, key, randomUUID())),
    );

    expect(body).toMatchObject({ status: 409, code: "WALK_IN_STORE_CREDIT_REFUSED" });
    const notes = await notesOf(walkInId);
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(oldId);
    expect(notes[0].status).toBe("ISSUED"); // the void rolled back with the refused replacement
  }, 30_000);
});
