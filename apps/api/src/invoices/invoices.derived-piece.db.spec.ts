/**
 * Units P0b (SA-759r) - real-Postgres pin for a MANUAL invoice: an old client's derived Piece (a 3-pack at $20, 2 pcs typed at
 * the rounded $6.67) is stored as the pack line's pieces and bills $13.33; for a product the customer has a tier-3 override on
 * ($16 pack) the derived price resolves at THAT tier per product, as an order does ($5.33 typed -> 2 pcs = $10.67).
 * Throwaway `qa-p0binv-*` tenants approved by `assertTestTenant`; collected only by jest.db.config.js.
 */

// Prevent Jest from traversing ESM-only dependencies (same guard as invoices.service.spec.ts /
// invoice-numbering.db.spec.ts).
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);

describeDb(
  "Units P0b: a derived Piece on a manual invoice is the pack's pieces, real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoicesService: InvoicesService;
    let tenantId = "";
    let productId = "";
    let customerPlain = "";
    let customerTier3 = "";

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
    // flag.units_v1 ON (selling by a unit is gated on it); every other flag OFF.
    const mockEntitlements = {
      hasFlag: jest.fn(async (_t: string, flag: string) => flag === "flag.units_v1"),
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

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          InvoicesService,
          SellingRestrictionsService,
          ProductLabelsService,
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
          entitlementAuthorityFromEntitlements, // #2241
          { provide: CommissionEngineService, useValue: mockCommissionEngine },
        ],
      }).compile();

      invoicesService = module.get(InvoicesService);

      const slug = assertTestTenant(`qa-p0binv-${RUN_SUFFIX}`, "invoices.derived-piece.db.spec.ts");
      tenantId = (await prisma.tenant.create({ data: { slug, name: `P0b ${slug}` } })).id;
      const customer = async (tag: string) => {
        const user = await prisma.user.create({
          data: {
            email: `${tag}-${RUN_SUFFIX}@example.invalid`,
            username: `${tag}-${RUN_SUFFIX}`,
            role: "CUSTOMER",
            tenantId,
          },
        });
        return (
          await prisma.customer.create({
            data: { userId: user.id, businessName: `${tag} co`, contactName: "T", tenantId },
          })
        ).id;
      };
      customerPlain = await customer("plain");
      customerTier3 = await customer("tier3");
      // a 3-pack at $20 (tier 3: $16) with a Case of 12 that has no price of its own: the Piece is DERIVED
      productId = (
        await prisma.product.create({
          data: {
            tenantId,
            name: `P0b pack ${RUN_SUFFIX}`,
            unit: "Pack",
            unitsPerBox: 3,
            pricePerUnit: "20.00",
            priceTier3: "16.00",
          },
        })
      ).id;
      await prisma.productUnit.create({
        data: { tenantId, productId, label: "Case", factorToBase: 12 },
      });
      await prisma.customerPrice.create({
        data: { tenantId, customerId: customerTier3, productId, pricingTier: 3 },
      });
    }, 120_000);

    afterAll(async () => {
      if (tenantId) {
        await prisma.invoiceItem.deleteMany({ where: { tenantId } }).catch(() => undefined);
        await prisma.invoice.deleteMany({ where: { tenantId } }).catch(() => undefined);
        await prisma.numberingSequence.deleteMany({ where: { tenantId } }).catch(() => undefined);
        await prisma.customerPrice.deleteMany({ where: { tenantId } }).catch(() => undefined);
        await prisma.productUnit.deleteMany({ where: { tenantId } }).catch(() => undefined);
        await prisma.customer.deleteMany({ where: { tenantId } }).catch(() => undefined);
        await prisma.product.deleteMany({ where: { tenantId } }).catch(() => undefined);
        await prisma.systemConfig.deleteMany({ where: { tenantId } }).catch(() => undefined);
        await prisma.user.deleteMany({ where: { tenantId } }).catch(() => undefined);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
      }
      await prisma?.$disconnect();
    });

    const createFor = (customerId: string, unitPrice: number) =>
      tenantCtx.run(tenantId, () =>
        invoicesService.create({
          customerId,
          items: [{ description: "Pack", productId, qty: 2, unitPrice, unitLabel: "Piece" }],
        } as never),
      );
    const itemsOf = (invoiceId: string) =>
      prisma.invoiceItem.findMany({ where: { invoiceId }, orderBy: { createdAt: "asc" } });

    it("default tier: 2 pcs typed at $6.67 store the pack's pieces at $20 and bill $13.33", async () => {
      const inv = (await createFor(customerPlain, 6.67)) as { id: string };
      const [line] = await itemsOf(inv.id);
      expect(line.unitLabel).toBeNull();
      expect({
        boxes: line.boxes,
        pieces: line.pieces,
        upb: Number(line.unitsPerBox),
        unitPrice: Number(line.unitPrice),
        subtotal: Number(line.subtotal),
      }).toEqual({ boxes: 0, pieces: 2, upb: 3, unitPrice: 20, subtotal: 13.33 });
    });

    it("a per-product CustomerPrice tier 3: the derived $5.33 resolves at the $16 pack and 2 pcs bill $10.67", async () => {
      const inv = (await createFor(customerTier3, 5.33)) as { id: string };
      const [line] = await itemsOf(inv.id);
      expect(line.unitLabel).toBeNull();
      expect({
        boxes: line.boxes,
        pieces: line.pieces,
        unitPrice: Number(line.unitPrice),
        subtotal: Number(line.subtotal),
      }).toEqual({ boxes: 0, pieces: 2, unitPrice: 16, subtotal: 10.67 });
    });
  },
);
