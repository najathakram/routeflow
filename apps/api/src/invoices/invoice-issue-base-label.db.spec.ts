/**
 * SA-1029 A-1 (red first) — real-Postgres proof that the per-piece unit word is frozen from ONE flag-free read taken before
 * the transaction, for every line with a productId, on every DRAFT -> issued site, and reaches the email surfaces.
 *
 *   D-R3  a flag-off tenant (customer not PIECES): a DRAFT with a Bag pack line paid at delivery freezes "Bag".
 *   D-R4  an unlabelled product's pack line freezes "Piece" (reads "pc"); a later "Bag" label never moves it.
 *   D-R5  a loose line with a productId freezes too.
 *   E-R2  the first send's snapshot and the payment reminder both print the product's word ("bag"), not "pc".
 *
 * Runs only under `npm run local:test:db`. Throwaway `qa-sa1029-*` tenants approved by `assertTestTenant`, deleted in FK
 * order in afterAll. Acme fixtures only.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({ getOrGenerate: jest.fn() })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../orders/orders.service", () => ({ OrdersService: class OrdersService {} }));

import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { AfterCommit } from "../common/after-commit";
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { _resetLockPoolForTests } from "../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { freezeDraftIssueUnits, itemsWithDisplayUnits } from "./invoice-display-unit";
import { buildInvoiceEmailPayload } from "./invoice-email-payload";
import { readSendSnapshot } from "./invoice-send-snapshot";
import { sendReminder } from "./invoice-reminder-email";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
/** The plan flag is OFF for every tenant here: the catalog is null unless the customer is PIECES (SA-1029 F1). */
const flagOff = { hasFlagStrict: jest.fn().mockResolvedValue(false) };

describeDb("SA-1029 A-1 base-word freeze from one pre-tx read — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    requireLocalDatabaseUrl();
    const mod = await Test.createTestingModule({
      providers: [
        InvoicesService,
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
        RegulatedLedgerService,
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
        {
          provide: MessagingService,
          useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
        },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
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
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.advancePayment.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.paymentCounter.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await _resetLockPoolForTests();
    await prisma?.$disconnect();
  });

  type LineKind = "pack" | "loose";
  /**
   * One invoice (status as given) with an order, and one line per entry of `lines`: a product with that base label (null =
   * unlabelled) and either a pack line (2 x 24 @ 48.00 = $2.00/pc) or a loose line (3 pieces @ 2.00).
   */
  async function seed(
    label: string,
    lines: Array<{ baseUnitLabel: string | null; kind: LineKind }>,
    status: "DRAFT" | "SENT" = "DRAFT",
  ) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa1029-${RUN}-${seq}-${label}`,
      "invoice-issue-base-label.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA1029 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `Acme ${label}`,
        contactName: "Pat",
        email: `buyer-${slug}@example.invalid`,
        tenantId,
      },
    });
    const total = lines.reduce((s, l) => s + (l.kind === "pack" ? 96 : 6), 0);
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        status: "DELIVERED",
        fulfillPath: "ROUTE",
        subtotal: total,
        tax: 0,
        total,
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-SA1029-${RUN}-${seq}`,
        status,
        sentAt: status === "DRAFT" ? null : new Date(),
        subtotal: total,
        taxAmount: 0,
        total,
      },
    });
    const products: Array<{ id: string }> = [];
    const items: Array<{ id: string }> = [];
    for (const [i, l] of lines.entries()) {
      const product = await prisma.product.create({
        data: {
          tenantId,
          name: `Acme case ${label} ${i}`,
          unit: "Case",
          packLabel: "Case",
          baseUnitLabel: l.baseUnitLabel,
          unitsPerBox: 24,
          pricePerUnit: 48,
        },
      });
      products.push(product);
      const pack = l.kind === "pack";
      const orderItem = await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          qty: pack ? 2 : 3,
          unitPrice: pack ? 48 : 2,
          subtotal: pack ? 96 : 6,
        },
      });
      items.push(
        await prisma.invoiceItem.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            orderItemId: orderItem.id,
            productId: product.id,
            description: `Acme case ${i}`,
            qty: pack ? 2 : 3,
            boxes: pack ? 2 : 0,
            pieces: pack ? 0 : 3,
            unitsPerBox: pack ? 24 : null,
            unitPrice: pack ? 48 : 2,
            discount: 0,
            taxRate: 0,
            subtotal: pack ? 96 : 6,
          },
        }),
      );
    }
    return { tenantId, customer, order, invoice, products, items };
  }

  const frozenWord = async (id: string) =>
    (await prisma.invoiceItem.findUniqueOrThrow({ where: { id }, select: { baseLabel: true } }))
      .baseLabel;

  const perPiece = async (invoiceId: string, status: "DRAFT" | "SENT") => {
    const inv = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { items: true },
    });
    const out = await itemsWithDisplayUnits(prisma, { ...inv, status }, flagOff);
    return out.map((i: any) => i.perBaseUnit ?? null);
  };

  it("D-R3: flag off, customer not PIECES: a DRAFT Bag pack line paid at delivery freezes Bag", async () => {
    const s = await seed("deliver", [{ baseUnitLabel: "Bag", kind: "pack" }]);
    const stop = { customerId: s.customer.id, orders: [{ id: s.order.id }] };
    await tenantCtx.run(s.tenantId, async () => {
      const catalog = await invoices.loadUnitCatalog(stop);
      expect(catalog).toBeNull(); // the entry condition: flag off and not PIECES, so no catalog
      const taken = await prisma.tenantTransaction((tx: any) =>
        invoices.recordDeliveryPaymentInTx(
          tx,
          new AfterCommit(),
          [s.order.id],
          96,
          "CASH",
          catalog,
        ),
      );
      expect(taken.applied).toBe(96);
    });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoice.id } })).status).toBe(
      "PAID",
    );
    expect(await frozenWord(s.items[0].id)).toBe("Bag");
  }, 120_000);

  it("D-R4: an unlabelled product's pack line freezes Piece; a later Bag label does not move the issued word", async () => {
    const s = await seed("unlabelled", [{ baseUnitLabel: null, kind: "pack" }]);
    await freezeDraftIssueUnits(
      prisma,
      prisma,
      { id: s.invoice.id, tenantId: s.tenantId },
      flagOff,
    );
    await prisma.invoice.update({ where: { id: s.invoice.id }, data: { status: "SENT" } });
    await prisma.product.update({
      where: { id: s.products[0].id },
      data: { baseUnitLabel: "Bag" },
    });
    expect({
      perPiece: await perPiece(s.invoice.id, "SENT"),
      baseLabel: await frozenWord(s.items[0].id),
    }).toEqual({ perPiece: [{ price: 2, unit: "pc" }], baseLabel: "Piece" });
  });

  it("D-R5: a loose line with a productId freezes its word too", async () => {
    const s = await seed("loose", [{ baseUnitLabel: "Bag", kind: "loose" }]);
    await freezeDraftIssueUnits(
      prisma,
      prisma,
      { id: s.invoice.id, tenantId: s.tenantId },
      flagOff,
    );
    expect(await frozenWord(s.items[0].id)).toBe("Bag");
  });

  it("E-R2: the first send's snapshot, built into the email payload, prints the Bag word", async () => {
    const s = await seed("first-send", [{ baseUnitLabel: "Bag", kind: "pack" }]);
    const creditNotes = {
      settleOrderCreditsInTx: jest.fn(),
      autoApplyOldestCreditsInTx: jest.fn(),
    };
    const { snapshot, issuing } = await tenantCtx.run(s.tenantId, () =>
      readSendSnapshot(prisma, creditNotes as never, s.invoice.id, null),
    );
    expect(issuing).toBe(true);
    const payload = buildInvoiceEmailPayload(snapshot, {
      recipientEmail: "buyer@example.invalid",
      pdfUrl: undefined,
      attachment: undefined,
      hideOriginalPrice: false,
    });
    expect(payload.items[0].perBaseUnit?.unit).toBe("bag");
  });

  it("E-R2: the reminder on a legacy issued Bag line (no frozen word) prints the Bag word", async () => {
    const s = await seed("reminder", [{ baseUnitLabel: "Bag", kind: "pack" }], "SENT");
    const sent: any[] = [];
    const deps = {
      prisma,
      emailService: {
        isEmailConfigured: jest.fn().mockResolvedValue(true),
        sendInvoice: jest.fn(async (p: unknown) => {
          sent.push(p);
          return { delivered: true };
        }),
      },
      pdfService: { getOrGenerate: jest.fn().mockResolvedValue(undefined) },
      storage: { download: jest.fn() },
      systemConfig: { get: jest.fn().mockResolvedValue(null) },
      logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    };
    await tenantCtx.run(s.tenantId, () => sendReminder(deps as never, s.invoice.id));
    expect(sent).toHaveLength(1);
    expect(sent[0].items[0].perBaseUnit?.unit).toBe("bag");
  });

  describe("D-R6 (B1275): every revert to DRAFT clears the issue-time word", () => {
    /** A Bag line is issued, the invoice is put in `from`, then the product is renamed Pack. */
    async function issuedThenRenamed(label: string, from: "SENT" | "VOID" | "PAID") {
      const s = await seed(label, [{ baseUnitLabel: "Bag", kind: "pack" }]);
      await freezeDraftIssueUnits(
        prisma,
        prisma,
        { id: s.invoice.id, tenantId: s.tenantId },
        flagOff,
      );
      await prisma.invoice.update({
        where: { id: s.invoice.id },
        data: { status: from, sentAt: new Date() },
      });
      await prisma.product.update({
        where: { id: s.products[0].id },
        data: { baseUnitLabel: "Pack" },
      });
      return s;
    }
    /** What the reverted DRAFT shows, and the word a re-issue then freezes. */
    async function afterRevert(s: Awaited<ReturnType<typeof seed>>) {
      const status = (await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoice.id } }))
        .status;
      const baseLabel = await frozenWord(s.items[0].id);
      const draft = await perPiece(s.invoice.id, "DRAFT");
      await freezeDraftIssueUnits(
        prisma,
        prisma,
        { id: s.invoice.id, tenantId: s.tenantId },
        flagOff,
      );
      return { status, baseLabel, draft, reissued: await frozenWord(s.items[0].id) };
    }
    const expected = {
      status: "DRAFT",
      baseLabel: null,
      draft: [{ price: 2, unit: "pack" }],
      reissued: "Pack",
    };

    it("D-R6: revertLinkedInvoicesForOrderEdit", async () => {
      const s = await issuedThenRenamed("d6-order-edit", "SENT");
      await tenantCtx.run(s.tenantId, () => invoices.revertLinkedInvoicesForOrderEdit(s.order.id));
      expect(await afterRevert(s)).toEqual(expected);
    });

    it("D-R6: unvoidInvoice", async () => {
      const s = await issuedThenRenamed("d6-unvoid", "VOID");
      await tenantCtx.run(s.tenantId, () => invoices.unvoidInvoice(s.invoice.id));
      expect(await afterRevert(s)).toEqual(expected);
    });

    it("D-R6: reopenInvoice", async () => {
      const s = await issuedThenRenamed("d6-reopen", "PAID");
      await tenantCtx.run(s.tenantId, () => invoices.reopenInvoice(s.invoice.id));
      expect(await afterRevert(s)).toEqual(expected);
    });
  });
});
