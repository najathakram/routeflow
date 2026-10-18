/**
 * B299 / SA-814 R4-5, real Postgres: void A, bill B for the same goods, unvoid A. The re-claim was clamped at
 * the line qty, so both invoices went live for one set of goods; `unvoidInvoice` now refuses with 409
 * ORDER_BILLING_CHANGED (under the SA-760 R-1 Order -> Invoice locks), A stays VOID and invoicedQty is untouched.
 * Controls: the quantity free -> unvoids and re-claims; a CANCELLED target line -> refused.
 * The mocked-tx rows live in ./invoices.unvoid-billing-claim-b299.spec.ts.
 *
 * Runs only under `npm run local:test:db`. Throwaway `qa-b299-<run>-<n>` tenants.
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
import { Client } from "pg";
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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b299-${RUN_SUFFIX}-${tenantSeq}`,
    "b299-unvoid-billing-claim.db.spec.ts",
  );
}

describeDb("B299: unvoid re-claims invoicedQty only when the quantity is still free", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoicesService: InvoicesService;
  const createdTenantIds: string[] = [];

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
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
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
        entitlementAuthorityFromEntitlements,
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
      ],
    }).compile();

    invoicesService = module.get(InvoicesService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      const where = { tenantId };
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await prisma.invoiceItem.deleteMany({ where });
        await prisma.invoice.deleteMany({ where });
        await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
        await prisma.order.deleteMany({ where });
        await prisma.product.deleteMany({ where });
        await prisma.customer.deleteMany({ where });
        await prisma.user.deleteMany({ where });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      })().catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  /**
   * A CONFIRMED order with one 96-piece line, and invoice A (VOID, billing all 96; voiding released its
   * invoicedQty so the line reads 0). `lineStatus` lets a row seed the line CANCELLED.
   */
  async function seedVoidA(lineStatus = "CONFIRMED") {
    const slug = freshTenantSlug();
    const tenant = await prisma.tenant.create({ data: { slug, name: `B299 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "B299",
        contactName: "B299",
        tenantId: tenant.id,
      } as any,
    });
    const product = await prisma.product.create({
      data: { name: `B299 ${slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id } as any,
    });
    const order = await prisma.order.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        orderNumber: `ORD-B299-${slug}`,
        status: "CONFIRMED",
        subtotal: 960,
        total: 960,
      } as any,
    });
    const item = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        qty: 96,
        unitPrice: 10,
        subtotal: 960,
        status: lineStatus,
        invoicedQty: 0,
        tenantId: tenant.id,
      } as any,
    });
    const invoiceA = await createInvoice(tenant.id, customer.id, order.id, item.id, product.id, {
      tag: "A",
      status: "VOID",
    });
    return {
      tenantId: tenant.id,
      customerId: customer.id,
      orderId: order.id,
      orderItemId: item.id,
      productId: product.id,
      invoiceAId: invoiceA.id,
    };
  }

  type Seed = Awaited<ReturnType<typeof seedVoidA>>;

  async function createInvoice(
    tenantId: string,
    customerId: string,
    orderId: string,
    orderItemId: string,
    productId: string,
    o: { tag: string; status: string; qty?: number },
  ) {
    const qty = o.qty ?? 96;
    return prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        orderId,
        invoiceNumber: `INV-B299${o.tag}-${randomUUID().slice(0, 8)}`,
        status: o.status,
        subtotal: qty * 10,
        total: qty * 10,
        items: {
          create: [
            {
              tenantId,
              orderItemId,
              productId,
              description: "line",
              qty,
              unitPrice: 10,
              subtotal: qty * 10,
            },
          ],
        },
      } as any,
    });
  }

  /** B bills `qty` of the same line and holds that much of the line's invoicedQty. */
  async function billB(s: Seed, qty: number) {
    await createInvoice(s.tenantId, s.customerId, s.orderId, s.orderItemId, s.productId, {
      tag: "B",
      status: "DRAFT",
      qty,
    });
    await prisma.orderItem.update({ where: { id: s.orderItemId }, data: { invoicedQty: qty } });
  }

  const unvoidA = (s: Seed) => () =>
    tenantCtx.run(s.tenantId, () => invoicesService.unvoidInvoice(s.invoiceAId));

  const readBack = async (s: Seed) => ({
    status: (await prisma.invoice.findUnique({ where: { id: s.invoiceAId } }))!.status,
    invoicedQty: Number(
      (await prisma.orderItem.findUnique({ where: { id: s.orderItemId } }))!.invoicedQty,
    ),
  });

  it("(a) void A, bill B for the same lines, unvoid A -> 409 ORDER_BILLING_CHANGED; A stays VOID, invoicedQty unchanged", async () => {
    const s = await seedVoidA();
    await billB(s, 96);
    await expect(unvoidA(s)()).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: "ORDER_BILLING_CHANGED",
        reason: "OTHER_INVOICE",
      }),
    });
    // master: A flips to DRAFT and the clamp keeps invoicedQty at 96 = both invoices live for the same goods
    expect(await readBack(s)).toEqual({ status: "VOID", invoicedQty: 96 });
  });

  it("(a) a partial overlap (B bills 60 of 96, A bills 96) is refused too", async () => {
    const s = await seedVoidA();
    await billB(s, 60);
    await expect(unvoidA(s)()).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "ORDER_BILLING_CHANGED",
        reason: "OTHER_INVOICE",
      }),
    });
    expect(await readBack(s)).toEqual({ status: "VOID", invoicedQty: 60 });
  });

  it("(b) control: the quantity is free -> A unvoids to DRAFT and re-claims all 96", async () => {
    const s = await seedVoidA();
    await unvoidA(s)();
    expect(await readBack(s)).toEqual({ status: "DRAFT", invoicedQty: 96 });
  });

  it("(c) a CANCELLED target order line is refused; A stays VOID", async () => {
    const s = await seedVoidA("CANCELLED");
    await expect(unvoidA(s)()).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "ORDER_BILLING_CHANGED",
        reason: "LINE_REDUCED",
      }),
    });
    expect(await readBack(s)).toEqual({ status: "VOID", invoicedQty: 0 });
  });

  it("SA-814d: nothing else bills the line but the order line was cut below A's qty -> 409 LINE_REDUCED", async () => {
    const s = await seedVoidA();
    await prisma.orderItem.update({ where: { id: s.orderItemId }, data: { qty: 50 } });
    await expect(unvoidA(s)()).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: "ORDER_BILLING_CHANGED",
        reason: "LINE_REDUCED",
        message:
          "The order line now holds less than this invoice bills. Raise the order line, or create a new invoice from the order.",
      }),
    });
    expect(await readBack(s)).toEqual({ status: "VOID", invoicedQty: 0 });
  });

  it("SA-814: A's order line was hard-deleted (orderItemId SetNull, product not on the order) -> 409 LINE_REDUCED; A stays VOID", async () => {
    const s = await seedVoidA();
    await prisma.orderItem.delete({ where: { id: s.orderItemId } });
    await expect(unvoidA(s)()).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: "ORDER_BILLING_CHANGED",
        reason: "LINE_REDUCED",
      }),
    });
    expect((await prisma.invoice.findUnique({ where: { id: s.invoiceAId } }))!.status).toBe("VOID");
  });

  it("SA-814 control: a free-form line (no productId, no orderItemId) beside a matched line is NOT refused", async () => {
    const s = await seedVoidA();
    await prisma.invoiceItem.create({
      data: {
        tenantId: s.tenantId,
        invoiceId: s.invoiceAId,
        description: "Delivery surcharge",
        qty: 1,
        unitPrice: 5,
        subtotal: 5,
      } as any,
    });
    await unvoidA(s)();
    expect(await readBack(s)).toEqual({ status: "DRAFT", invoicedQty: 96 });
  });
});
