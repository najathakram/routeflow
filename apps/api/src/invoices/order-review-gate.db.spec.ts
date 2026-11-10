/**
 * SA-1124 PR-1b - the review gate against real Postgres: send, the staff payment writers, the exempt writers, and
 * the DRAFT / deposit-mirror steps, with a real OrderReviewFlag row (rows G1-G4 of the brief).
 *
 * Real: PrismaService, InvoicesService, FeatureConfigService + store, RegulatedLedgerService. Stubbed: the usual
 * invoices-spec collaborators, and SystemConfigService (deposit-at-order reads ON, everything else unset).
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway `qa-1124-<run>-<n>` slug
 * approved by `assertTestTenant`, deleted in FK order in afterAll.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { AfterCommit } from "../common/after-commit";
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { FeatureConfigStore } from "../billing/feature-config.store";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("the offline price-review gate on a real database (SA-1124 PR-1b)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const mod = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        EstimatesService,
        FeatureConfigStore,
        {
          provide: FeatureConfigService,
          useFactory: (p: PrismaService, store: FeatureConfigStore) =>
            new FeatureConfigService(p, store, {} as any, {} as any, {} as any, {} as any),
          inject: [PrismaService, FeatureConfigStore],
        },
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
          useValue: {
            // deposit-at-order is ON (G4); every other key reads as unset
            get: jest.fn(async (key: string) =>
              key === "invoice.depositCollectAtOrder" ? "true" : null,
            ),
            set: jest.fn(),
          },
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
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
        entitlementAuthorityFromEntitlements, // #2241
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
  });

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
      await prisma.orderReviewFlag.deleteMany(where).catch(swallow);
      await prisma.systemConfig.deleteMany(where).catch(swallow);
      await prisma.advancePayment.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.paymentCounter.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.deliveryMutation.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenantFeatureConfig.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /**
   * One throwaway tenant with a customer on a 50% deposit, one order with one 2 x $25 line, an open
   * PRICE_CHANGED_OFFLINE flag on it, and (when asked) the order's invoice in the given status, 50 / 5 / 55.
   */
  async function seed(
    label: string,
    opts: { invoice?: "DRAFT" | "SENT" | null; flagged?: boolean } = {},
  ) {
    const invoice = opts.invoice === undefined ? "SENT" : opts.invoice;
    const flagged = opts.flagged ?? true;
    seq += 1;
    const slug = assertTestTenant(`qa-1124-${RUN}-${seq}-${label}`, "order-review-gate.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA-1124 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `c ${label}`,
        contactName: `c ${label}`,
        tenantId,
        defaultDepositPercent: 50,
      },
    });
    const product = await prisma.product.create({
      data: { tenantId, name: `p ${label}`, unit: "each", pricePerUnit: 25 },
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        fulfillPath: "ROUTE",
        status: "CONFIRMED",
        subtotal: 50,
        tax: 5,
        total: 55,
      },
    });
    const li = await prisma.orderItem.create({
      data: {
        tenantId,
        orderId: order.id,
        productId: product.id,
        qty: 2,
        unitPrice: 25,
        subtotal: 50,
      },
    });
    let flagId: string | null = null;
    if (flagged) {
      const flag = await prisma.orderReviewFlag.create({
        data: {
          tenantId,
          orderId: order.id,
          orderItemId: li.id,
          kind: "PRICE_CHANGED_OFFLINE",
          detail: { quotedUnitPrice: 20, currentUnitPrice: 25 },
        },
      });
      flagId = flag.id;
    }
    let invoiceId: string | null = null;
    if (invoice) {
      const inv = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-1124-${RUN}-${seq}`,
          status: invoice,
          sentAt: invoice === "SENT" ? new Date() : null,
          subtotal: 50,
          taxAmount: 5,
          total: 55,
        },
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: inv.id,
          orderItemId: li.id,
          productId: product.id,
          description: `p ${label}`,
          qty: 2,
          unitPrice: 25,
          subtotal: 50,
        },
      });
      invoiceId = inv.id;
    }
    return { tenantId, customerId: customer.id, orderId: order.id, invoiceId, flagId };
  }
  const resolve = (flagId: string | null) =>
    prisma.orderReviewFlag.update({
      where: { id: flagId! },
      data: { resolvedAt: new Date(), resolution: "price reviewed" },
    });
  const openFlags = (orderId: string) =>
    prisma.orderReviewFlag.count({ where: { orderId, resolvedAt: null } });
  const paymentRows = (invoiceId: string) => prisma.invoicePayment.count({ where: { invoiceId } });
  const asTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  it("G1: send of the order's DRAFT invoice is 409 ORDER_REVIEW_REQUIRED while flagged, and goes through once the flag is resolved", async () => {
    const s = await seed("g1", { invoice: "DRAFT" });
    const err: any = await asTenant(s.tenantId, () =>
      invoices.send(s.invoiceId!, { allowPreDelivery: true }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "ORDER_REVIEW_REQUIRED",
      orderId: s.orderId,
      openKinds: ["PRICE_CHANGED_OFFLINE"],
    });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId! } })).status).toBe(
      "DRAFT",
    );

    await resolve(s.flagId);
    const sent: any = await asTenant(s.tenantId, () =>
      invoices.send(s.invoiceId!, { allowPreDelivery: true }),
    );
    expect(sent.status).toBe("SENT");
  });

  it("G2: a staff payment is 409 while flagged (per invoice and standalone), and nothing is written", async () => {
    const s = await seed("g2");
    const perInvoice: any = await asTenant(s.tenantId, () =>
      invoices.recordPayment(s.invoiceId!, { amount: 10, method: "CASH" } as never),
    ).catch((e) => e);
    expect(perInvoice).toBeInstanceOf(ConflictException);
    expect(perInvoice.getResponse()).toMatchObject({ code: "ORDER_REVIEW_REQUIRED" });

    const standalone: any = await asTenant(s.tenantId, () =>
      invoices.recordStandalonePayment(
        {
          customerId: s.customerId,
          totalAmount: 10,
          method: "CASH",
          allocations: [{ invoiceId: s.invoiceId!, amount: 10 }],
        } as any,
        { source: "STAFF_ALLOCATION" },
      ),
    ).catch((e) => e);
    expect(standalone).toBeInstanceOf(ConflictException);
    expect(standalone.getResponse()).toMatchObject({ code: "ORDER_REVIEW_REQUIRED" });

    expect(await paymentRows(s.invoiceId!)).toBe(0);
    expect(await openFlags(s.orderId)).toBe(1);

    await resolve(s.flagId); // the same call, once reviewed: master's value
    await asTenant(s.tenantId, () =>
      invoices.recordPayment(s.invoiceId!, { amount: 10, method: "CASH" } as never),
    );
    expect(await paymentRows(s.invoiceId!)).toBe(1);
  });

  it("G2: money that already moved records while flagged and leaves the flag open (Stripe settle, driver cash at the door)", async () => {
    const s = await seed("g2x");
    await asTenant(s.tenantId, () =>
      invoices.recordStandalonePayment(
        {
          customerId: s.customerId,
          totalAmount: 10,
          method: "CARD",
          reference: `pi_1124${RUN}`,
          allocations: [{ invoiceId: s.invoiceId!, amount: 10 }],
        } as any,
        { source: "STRIPE_SETTLE" },
      ),
    );
    expect(await paymentRows(s.invoiceId!)).toBe(1);

    const taken = await asTenant(s.tenantId, () =>
      prisma.tenantTransaction((tx: any) =>
        invoices.recordDeliveryPaymentInTx(
          tx,
          new AfterCommit(),
          [s.orderId],
          20,
          "CASH",
          null,
          null,
        ),
      ),
    );
    expect(taken.applied).toBe(20);
    expect(await paymentRows(s.invoiceId!)).toBe(2);
    expect(await openFlags(s.orderId)).toBe(1); // recording money never resolves the review
  });

  it("G3: createInvoiceFromOrder on a flagged order creates its DRAFT invoice (the gate never blocks a DRAFT)", async () => {
    const s = await seed("g3", { invoice: null });
    const made: any = await asTenant(s.tenantId, () => invoices.createInvoiceFromOrder(s.orderId));
    expect(made).toHaveLength(1);
    expect(made[0].status).toBe("DRAFT");
    expect(await prisma.invoice.count({ where: { orderId: s.orderId } })).toBe(1);
  });

  it("G4: with deposit-at-order ON the flagged order's deposit mirror stays DRAFT and the create does not throw; unflagged it is issued", async () => {
    const flagged = await seed("g4f", { invoice: null });
    const mirror: any = await asTenant(flagged.tenantId, () =>
      invoices.createInvoiceFromOrder(flagged.orderId),
    );
    expect(mirror).toHaveLength(1);
    expect(mirror[0].status).toBe("DRAFT");

    const clean = await seed("g4c", { invoice: null, flagged: false }); // master's value for the same call
    const issued: any = await asTenant(clean.tenantId, () =>
      invoices.createInvoiceFromOrder(clean.orderId),
    );
    expect(issued).toHaveLength(1);
    expect(issued[0].status).toBe("SENT");
  });
});
