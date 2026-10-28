/**
 * SA-1034 — real-Postgres cases for the price-edit capability at the line edit, THROUGH the real services:
 *  R1   a platform principal (role SUPER_ADMIN, no impersonation) typing a new line price is refused 403
 *       PRICE_EDIT_NOT_PERMITTED on OrdersService.updateOrderItems and on InvoicesService.update (a DRAFT);
 *       the stored line is unchanged.
 *  G1   the same edit by an impersonation principal (role TENANT_ADMIN, impersonatedBy set) is written,
 *       attributed to that tenant admin.
 *  B-G1 a CUSTOMER and a DRIVER create() with {unitLabel, unitPrice} meet the selling-unit 400; no order row.
 *  T-G1 a refused edit is an HttpException 403 (never a 500), moves no orderItem / stockMovement / return
 *       row, and a second call with the same idempotency key meets the same 403 (no key is recorded).
 *  PR7  an OPERATOR whose deny list holds PRICING (written by the fixture: no API writes it yet): with the
 *       permissions mode forced `live` (a test-only spy on OperatorPermissionsService.mode) the order create,
 *       the order line edit and the invoice line edit are refused 403 PRICE_EDIT_NOT_PERMITTED and the inline
 *       return credit price 400 RETURN_CREDIT_OVERRIDE_FORBIDDEN, nothing written (M-R1, RC-R1); in `shadow`
 *       the same edit is written with one would-deny log line (M-G1). R1b: a real platform principal
 *       (tenantId null, tenantSlug null) is refused with no row written.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as b1050-delivered-edit.db.spec.ts does, and a
 * REAL InvoicesService through a Nest testing module, as invoices.sell-ban-edit-copy.db.spec.ts does.
 * NOT RUN by the lane that wrote it (no database on that machine); the DB lane runs it.
 *
 * SAFETY: one throwaway `qa-sa1034-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes exactly
 * the rows this run created.
 */
// Prevent Jest from traversing ESM-only dependencies (same guard as invoices.sell-ban-edit-copy.db.spec.ts).
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { HttpException, Logger } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { OperatorPermissionsService } from "../auth/permissions/operator-permissions.service";
import {
  InlineReturnsQuoteService,
  RETURN_CREDIT_OVERRIDE_ERROR_CODES,
} from "../returns/inline-returns-quote.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-1034 — price-edit capability at the line edit, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  let invoicesService: InvoicesService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-sa1034-${run}`, "price-edit-capability.db.spec.ts");
  let tenantId = "";
  let adminUserId = "";
  let buyerUserId = "";
  let driverUserId = "";
  let deniedOperatorId = ""; // OPERATOR, deniedPermissionGroups = [PRICING]
  let customerId = "";
  let productId = "";
  const platformUserId = `platform-${run}`; // a platform principal's id: never a row in this tenant
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];

  const principal = (
    role: "SUPER_ADMIN" | "TENANT_ADMIN" | "OPERATOR" | "CUSTOMER" | "DRIVER",
    sub: string,
    extra: Partial<JwtPayload> = {},
  ): JwtPayload =>
    ({
      sub,
      username: `${role.toLowerCase()}-${run}`,
      role,
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
      ...extra,
    }) as JwtPayload;
  /** A raw platform token: SUPER_ADMIN, no impersonation. */
  const platform = () => principal("SUPER_ADMIN", platformUserId);
  /** In-tenant support: the tenant admin's own principal, carrying who is impersonating. */
  const impersonation = () =>
    principal("TENANT_ADMIN", adminUserId, {
      impersonatedBy: platformUserId,
    } as Partial<JwtPayload>);

  const inTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const editOrder = (orderId: string, dto: any, who: JwtPayload, opts?: any) =>
    inTenant(() => orders.updateOrderItems(orderId, dto, who, opts));
  const editInvoice = (invoiceId: string, dto: any, who: JwtPayload) =>
    inTenant(() => invoicesService.update(invoiceId, dto, who));
  const caught = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);
  const expectPriceEditRefused = (err: unknown) => {
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(403);
    expect((err as HttpException).getResponse()).toMatchObject({
      code: API_ERROR_CODES.PRICE_EDIT_NOT_PERMITTED,
    });
  };

  /** A PENDING order holding one plain line: 2 x $10 at the list price (tier 1, no override). */
  async function order() {
    const o = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: "PENDING",
        subtotal: "20.00",
        total: "20.00",
        lineItems: {
          create: [
            {
              tenantId,
              productId,
              qty: 2,
              unitPrice: "10.00",
              subtotal: "20.00",
              priceType: "STANDARD",
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    orderIds.push(o.id);
    return o;
  }
  const lineOf = (lineId: string) => raw.orderItem.findUniqueOrThrow({ where: { id: lineId } });

  /** A DRAFT manual invoice with one plain line at $10 (created with no actor: no price columns). */
  async function draftInvoice() {
    const inv: any = await inTenant(() =>
      invoicesService.create({
        customerId,
        items: [{ description: "line", productId, qty: 2, unitPrice: 10 }],
      } as any),
    );
    invoiceIds.push(inv.id);
    const [held] = await raw.invoiceItem.findMany({ where: { invoiceId: inv.id } });
    return { id: inv.id as string, held };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as any),
    );
    orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      gateway: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
      systemConfig,
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: {
        getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        assertLinesSellable: async () => undefined,
      },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      tenantCtx,
      invoicesService: {
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        SellingRestrictionsService,
        ProductLabelsService,
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
            sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
            isEmailConfigured: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
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
          useValue: {
            notify: jest.fn().mockResolvedValue([]),
            notifyEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue("stored"),
            presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        // flag.msrp OFF: applyMsrpSnapshots no-ops.
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
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
    invoicesService = module.get(InvoicesService);

    tenantId = (await raw.tenant.create({ data: { slug, name: `sa1034 ${slug}` } })).id;
    adminUserId = (
      await raw.user.create({
        data: {
          email: `a-${run}@example.test`,
          username: `a-${run}`,
          role: "TENANT_ADMIN",
          tenantId,
        },
      })
    ).id;
    buyerUserId = (
      await raw.user.create({
        data: { email: `b-${run}@example.test`, username: `b-${run}`, role: "CUSTOMER", tenantId },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId: buyerUserId, businessName: "sa1034 co", contactName: "Tester", tenantId },
      })
    ).id;
    driverUserId = (
      await raw.user.create({
        data: { email: `d-${run}@example.test`, username: `d-${run}`, role: "DRIVER", tenantId },
      })
    ).id;
    await raw.driver.create({ data: { userId: driverUserId, tenantId } as any });
    deniedOperatorId = (
      await raw.user.create({
        data: {
          email: `o-${run}@example.test`,
          username: `o-${run}`,
          role: "OPERATOR",
          tenantId,
          deniedPermissionGroups: ["PRICING"],
        },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: {
          name: `sa1034 cola ${run}`,
          unit: "ea",
          pricePerUnit: "10.00",
          currentStock: "100",
          tenantId,
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await raw.orderIdempotencyKey.deleteMany({ where: { tenantId } });
    await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
    await raw.orderItem.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { tenantId } });
    await raw.auditLog.deleteMany({ where: { tenantId } });
    await raw.invoiceItem.deleteMany({ where: { tenantId } });
    await raw.invoice.deleteMany({ where: { tenantId } });
    await raw.numberingSequence.deleteMany({ where: { tenantId } });
    await raw.stockMovement.deleteMany({ where: { productId } });
    await raw.product.deleteMany({ where: { tenantId } });
    await raw.customer.deleteMany({ where: { tenantId } });
    await raw.driver.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  describe("R1 / G1 — order line edit", () => {
    it("price-edit capability: platform principal is refused at the order line edit; the line is unchanged", async () => {
      const o = await order();
      const line = o.lineItems[0];
      const err = await caught(
        editOrder(
          o.id,
          { replaceAll: false, items: [{ id: line.id, qty: 2, unitPrice: 6 }] },
          platform(),
        ),
      );
      expectPriceEditRefused(err);
      expect(await lineOf(line.id)).toMatchObject({
        priceType: "STANDARD",
        overriddenBy: null,
      });
      expect(Number((await lineOf(line.id)).unitPrice)).toBe(10);
    });

    it("price-edit capability: impersonation principal edits the order line, attributed to the tenant admin", async () => {
      const o = await order();
      const line = o.lineItems[0];
      await editOrder(
        o.id,
        { replaceAll: false, items: [{ id: line.id, qty: 2, unitPrice: 6 }] },
        impersonation(),
      );
      const after = await lineOf(line.id);
      expect(Number(after.unitPrice)).toBe(6);
      expect(after).toMatchObject({ priceType: "DISCOUNTED", overriddenBy: adminUserId });
    });
  });

  describe("R1 / G1 — invoice line edit (DRAFT)", () => {
    it("price-edit capability: platform principal is refused at the invoice line edit; the line is unchanged", async () => {
      const inv = await draftInvoice();
      const err = await caught(
        editInvoice(
          inv.id,
          { items: [{ id: inv.held.id, description: "line", productId, qty: 2, unitPrice: 6 }] },
          platform(),
        ),
      );
      expectPriceEditRefused(err);
      const after = await raw.invoiceItem.findUniqueOrThrow({ where: { id: inv.held.id } });
      expect(Number(after.unitPrice)).toBe(10);
      expect(after.overriddenBy).toBeNull();
    });

    it("price-edit capability: impersonation principal edits the invoice line, attributed to the tenant admin", async () => {
      const inv = await draftInvoice();
      await editInvoice(
        inv.id,
        { items: [{ id: inv.held.id, description: "line", productId, qty: 2, unitPrice: 6 }] },
        impersonation(),
      );
      const [after] = await raw.invoiceItem.findMany({ where: { invoiceId: inv.id } });
      expect(Number(after.unitPrice)).toBe(6);
      expect(after).toMatchObject({ priceType: "DISCOUNTED", overriddenBy: adminUserId });
    });
  });

  describe("B-G1 — a buyer or a driver never chooses a selling unit or a price on create", () => {
    it.each([
      ["CUSTOMER", () => principal("CUSTOMER", buyerUserId)],
      ["DRIVER", () => principal("DRIVER", driverUserId)],
    ])(
      "price-edit capability: %s create with a unit and a price is a 400; no order row",
      async (_role, who) => {
        const before = await raw.order.count({ where: { tenantId } });
        const err = await caught(
          inTenant(() =>
            orders.create(
              {
                customerId,
                items: [{ productId, qty: 1, unitLabel: "Case", unitPrice: 1 }],
              },
              who(),
            ),
          ),
        );
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(400);
        expect((err as Error).message).toMatch(/Only staff can choose a selling unit/);
        expect(await raw.order.count({ where: { tenantId } })).toBe(before);
      },
    );
  });

  describe("T-G1 — a refused edit is a clean 403 with no side effects", () => {
    it("price-edit capability: refused edit is a 403 (not a 500), moves no row, and a same-key retry is refused the same way", async () => {
      const o = await order();
      const line = o.lineItems[0];
      const counts = async () => ({
        orderItems: await raw.orderItem.count({ where: { orderId: o.id } }),
        stockMovements: await raw.stockMovement.count({ where: { productId } }),
        returns: await raw.return.count({ where: { tenantId } }),
        keys: await raw.orderIdempotencyKey.count({ where: { tenantId, orderId: o.id } }),
      });
      const before = await counts();
      const dto = { replaceAll: false, items: [{ id: line.id, qty: 3, unitPrice: 6 }] };
      const idempotency = { key: `sa1034-${run}`, responseHash: "sa1034-hash" };

      const first = await caught(editOrder(o.id, dto, platform(), { idempotency }));
      expectPriceEditRefused(first);
      expect(await counts()).toEqual(before);

      const second = await caught(editOrder(o.id, dto, platform(), { idempotency }));
      expectPriceEditRefused(second);
      expect(await counts()).toEqual(before);
      expect(Number((await lineOf(line.id)).qty)).toBe(2);
    });
  });

  describe("PR7 — a denied OPERATOR (PRICING off) and the real platform principal", () => {
    const denied = () => principal("OPERATOR", deniedOperatorId);
    /** The real platform token: no tenant on the principal at all. */
    const realPlatform = () =>
      principal("SUPER_ADMIN", platformUserId, { tenantId: null, tenantSlug: null } as any);
    const belowTierEdit = (line: { id: string }) => ({
      replaceAll: false,
      items: [{ id: line.id, qty: 2, unitPrice: 6 }],
    });
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());
    const wouldDeny = () =>
      warn.mock.calls.filter((c) => String(c[0]).includes("would-deny groups=PRICING"));
    const live = () =>
      jest.spyOn(OperatorPermissionsService.prototype, "mode").mockReturnValue("live");

    it("M-R1 live: the denied operator's order line edit is a 403 PRICE_EDIT_NOT_PERMITTED; the line is unchanged", async () => {
      live();
      const o = await order();
      const err = await caught(editOrder(o.id, belowTierEdit(o.lineItems[0]), denied()));
      expectPriceEditRefused(err);
      const after = await lineOf(o.lineItems[0].id);
      expect(Number(after.unitPrice)).toBe(10);
      expect(after.overriddenBy).toBeNull();
    });

    it("M-R1 live: the denied operator's invoice line edit is a 403; the line is unchanged", async () => {
      live();
      const inv = await draftInvoice();
      const err = await caught(
        editInvoice(
          inv.id,
          { items: [{ id: inv.held.id, description: "line", productId, qty: 2, unitPrice: 6 }] },
          denied(),
        ),
      );
      expectPriceEditRefused(err);
      const after = await raw.invoiceItem.findUniqueOrThrow({ where: { id: inv.held.id } });
      expect(Number(after.unitPrice)).toBe(10);
    });

    it("M-R1 live: the denied operator's order create with a below-tier price is a 403; no order row", async () => {
      live();
      const before = await raw.order.count({ where: { tenantId } });
      const err = await caught(
        inTenant(() =>
          orders.create(
            { customerId, items: [{ productId, qty: 1, unitPrice: 6, overrideReason: "sa1034" }] },
            denied(),
          ),
        ),
      );
      expectPriceEditRefused(err);
      expect(await raw.order.count({ where: { tenantId } })).toBe(before);
    });

    it("M-G1 shadow: the same denied operator's edit is written as on master, with one would-deny line", async () => {
      const o = await order();
      await editOrder(o.id, belowTierEdit(o.lineItems[0]), denied());
      const after = await lineOf(o.lineItems[0].id);
      expect(Number(after.unitPrice)).toBe(6);
      expect(after).toMatchObject({ priceType: "DISCOUNTED", overriddenBy: deniedOperatorId });
      expect(wouldDeny()).toHaveLength(1);
    });

    it("RC-R1 live / RC-G1 shadow: the inline return credit price is a 400 FORBIDDEN only when enforced", async () => {
      const quoteService = new InlineReturnsQuoteService(prisma, {
        get: async () => null,
      } as unknown as SystemConfigService);
      const dto: any = {
        customerId,
        items: [{ productId, boxes: 0, pieces: 1, creditUnitPrice: 1, overrideReason: "sa1034" }],
      };
      const attempt = () => caught(inTenant(() => quoteService.quote(dto, denied())));
      const shadowErr: any = await attempt(); // shadow: the price half passes; any later refusal is not this code
      expect(shadowErr?.getResponse?.()?.code).not.toBe(
        RETURN_CREDIT_OVERRIDE_ERROR_CODES.FORBIDDEN,
      );
      live();
      const liveErr: any = await attempt();
      expect(liveErr).toBeInstanceOf(HttpException);
      expect(liveErr.getStatus()).toBe(400);
      expect(liveErr.getResponse()).toMatchObject({
        code: RETURN_CREDIT_OVERRIDE_ERROR_CODES.FORBIDDEN,
      });
    });

    it("R1b: the real platform principal (tenantId null) is refused and writes no row", async () => {
      const o = await order();
      const counts = async () => ({
        items: await raw.orderItem.count({ where: { orderId: o.id } }),
        orders: await raw.order.count({ where: { tenantId } }),
        keys: await raw.orderIdempotencyKey.count({ where: { tenantId } }),
      });
      const before = await counts();
      const err: any = await caught(editOrder(o.id, belowTierEdit(o.lineItems[0]), realPlatform()));
      expectPriceEditRefused(err); // observed: 403 PRICE_EDIT_NOT_PERMITTED
      expect(Number((await lineOf(o.lineItems[0].id)).unitPrice)).toBe(10);
      expect(await counts()).toEqual(before);
    });
  });
});
