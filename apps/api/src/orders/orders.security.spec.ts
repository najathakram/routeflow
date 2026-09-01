/**
 * Security tests for the orders module.
 *
 * Tenant-scoped reads: `forTenant().model.findUnique` post-filters on the
 * returned row's tenantId, so an exclusive `select` that omits tenantId let a
 * cross-tenant id through (existence/status oracle + data echo). These reads
 * now use `findFirst`, which injects tenantId into the where. The specs pin
 * "a cross-tenant id 404s": findUnique is mocked to return the foreign row
 * (what the raw DB does), findFirst to return null (what the scoped read
 * does) — a revert to findUnique makes the foreign row leak and the test fail.
 */

// Mock InvoicesService before it's imported — prevents Jest from traversing
// invoice-pdf.service.ts which imports @react-pdf/renderer (ESM-only module)
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));

// Mock NotificationsService — it imports expo-server-sdk which is ESM-only
// and fails Jest's CommonJS parser.
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { OrdersService } from "./orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";

// A row belonging to ANOTHER tenant — findUnique (post-filter defeated by the
// exclusive select) hands it back; the scoped findFirst must miss it.
const FOREIGN_ORDER = { id: "ord-foreign", status: "PENDING", orderNumber: "X-1", shippedAt: null };

describe("OrdersService — cross-tenant id 404s on scoped reads", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken("invoices"), useValue: { add: jest.fn() } },
        { provide: RouteFlowGateway, useValue: { emitOrderStatusChanged: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(0.1) } },
        { provide: InvoicesService, useValue: {} },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: NotificationsService, useValue: {} },
        { provide: InventoryService, useValue: {} },
        {
          provide: AuthorizationGuardService,
          useValue: { assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: PromotionsService,
          useValue: { activeForCatalog: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: MessagingService,
          useValue: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: CreditNotesService,
          useValue: { previewOrderCreditRelease: jest.fn().mockResolvedValue([]) },
        },
        { provide: CommissionEngineService, useValue: {} },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        // B65: deleteOrder's per-invoice teardown reverses regulated-ledger entries.
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = module.get<OrdersService>(OrdersService);
  });

  describe("updateShipment", () => {
    it("404s a cross-tenant order id and never writes", async () => {
      prisma.order.findUnique.mockResolvedValue(FOREIGN_ORDER);
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(
        service.updateShipment("ord-foreign", { shippingTrackingNumber: "1Z" } as any),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    });

    it("updates a same-tenant order (scoped read hit)", async () => {
      prisma.order.findFirst.mockResolvedValue({ id: "ord-1", shippedAt: null });
      prisma.order.update.mockResolvedValue({ id: "ord-1" });

      await service.updateShipment("ord-1", { shippingTrackingNumber: "1Z" } as any);
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "ord-1" } }),
      );
    });
  });

  describe("cancelImpact", () => {
    it("404s a cross-tenant order id instead of echoing status/orderNumber", async () => {
      prisma.order.findUnique.mockResolvedValue(FOREIGN_ORDER);
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(service.cancelImpact("ord-foreign")).rejects.toThrow(NotFoundException);
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    });
  });
});
