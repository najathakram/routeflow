/**
 * SA-655 item 10 (buyer path): the portal's order create forwards an optional `fulfillPath`
 * (ROUTE | SHIP | PICKUP) to OrdersService.create, which resolves it against the business's capability
 * (resolve-fulfil-path.ts: an in-store business is ORDER AHEAD, PICK UP). Omitted = today's payload.
 */

jest.mock("../common/db-locks", () => {
  class LockTimeoutError extends Error {
    constructor(
      public readonly family: string,
      public readonly key: string,
      public readonly waitMs: number,
    ) {
      super(`advisory lock timeout: ${family}:${key} after ${waitMs}ms`);
      this.name = "LockTimeoutError";
    }
  }
  class LockUnavailableError extends Error {
    constructor(public readonly cause?: unknown) {
      super("advisory lock unavailable");
      this.name = "LockUnavailableError";
    }
  }
  return {
    withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
      acquired: true,
      value: await fn(),
    })),
    LockTimeoutError,
    LockUnavailableError,
  };
});

import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { BuyerController } from "./buyer.controller";
import { BuyerService } from "./buyer.service";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { ReplenishmentService } from "./replenishment.service";
import { ShelfService } from "./shelf.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { PromotionsService } from "../promotions/promotions.service";
import { OrdersService } from "../orders/orders.service";
import { ChangeRequestsService } from "../orders/change-requests.service";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { StatementService } from "./statement.service";
import { StatementPdfService } from "./statement-pdf.service";
import { CustomersService } from "../customers/customers.service";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { AuthorizationsService } from "../authorizations/authorizations.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { BuyerCreateOrderDto } from "./dto/buyer-create-order.dto";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import "reflect-metadata";

const MOCK_CTX = {
  customerId: "cust-merge-1",
  tenantId: "tenant-xyz",
  tenantSlug: "acme",
  userId: null, // buyer-portal-only account — no operator-portal user
  customer: { id: "cust-merge-1", businessName: "Merge Test Buyer" },
};

describe("BuyerController.createOrder — fulfilPath passthrough (SA-655)", () => {
  let controller: BuyerController;
  let ordersService: {
    create: jest.Mock;
    findActiveOrder: jest.Mock;
    mergeAllPendingForCustomer: jest.Mock;
  };
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    ordersService = {
      findActiveOrder: jest.fn().mockResolvedValue(null),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "order-fresh" }),
    };
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuyerController],
      providers: [
        oversellReaderOffProvider,
        { provide: BuyerService, useValue: {} },
        { provide: BuyerCatalogService, useValue: {} },
        { provide: BuyerDashboardService, useValue: {} },
        { provide: ReplenishmentService, useValue: {} },
        { provide: ShelfService, useValue: {} },
        { provide: StockAlertService, useValue: {} },
        { provide: PromotionsService, useValue: {} },
        { provide: OrdersService, useValue: ordersService },
        { provide: ChangeRequestsService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
        { provide: InvoicePdfService, useValue: {} },
        { provide: StatementService, useValue: {} },
        { provide: StatementPdfService, useValue: {} },
        { provide: CustomersService, useValue: {} },
        { provide: OrderTemplatesService, useValue: {} },
        { provide: AuthorizationsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: {} },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((id, fn) => fn()), getOrNull: jest.fn().mockReturnValue(null) },
        },
      ],
    }).compile();

    controller = module.get<BuyerController>(BuyerController);
  });

  const items = [{ productId: "prod-z", qty: 1 }];

  it.each(["PICKUP", "SHIP", "ROUTE"])(
    "forwards the buyer's %s choice to create()",
    async (fulfillPath) => {
      await controller.createOrder({ items, fulfillPath, forceNew: true } as any, MOCK_CTX as any);
      expect(ordersService.create.mock.calls[0][0].fulfillPath).toBe(fulfillPath);
    },
  );

  it("omitted: the create payload carries no fulfillPath key at all (today)", async () => {
    await controller.createOrder({ items, forceNew: true } as any, MOCK_CTX as any);
    expect(ordersService.create.mock.calls[0][0]).not.toHaveProperty("fulfillPath");
  });

  it("the merge search resolves the buyer's requested path too (a SHIP cart never folds into a PICKUP order)", async () => {
    await controller.createOrder({ items, fulfillPath: "SHIP" } as any, MOCK_CTX as any);
    expect(ordersService.findActiveOrder).toHaveBeenCalledWith(
      MOCK_CTX.customerId,
      expect.objectContaining({ mergeAs: { audience: "buyer", explicit: "SHIP" } }),
    );
  });

  it("omitted: the merge search is exactly today's (no explicit path)", async () => {
    await controller.createOrder({ items } as any, MOCK_CTX as any);
    expect(ordersService.findActiveOrder).toHaveBeenCalledWith(
      MOCK_CTX.customerId,
      expect.objectContaining({ mergeAs: { audience: "buyer" } }),
    );
  });
});

describe("BuyerCreateOrderDto.fulfillPath", () => {
  const check = async (fulfillPath: unknown) =>
    (
      await validate(
        plainToInstance(BuyerCreateOrderDto, {
          items: [{ productId: "p", qty: 1 }],
          fulfillPath,
        }) as object,
      )
    ).filter((e) => e.property === "fulfillPath");

  it.each(["ROUTE", "SHIP", "PICKUP", undefined])("accepts %s", async (v) => {
    expect(await check(v)).toHaveLength(0);
  });
  it("rejects anything else", async () => {
    expect((await check("DRONE")).length).toBeGreaterThan(0);
  });
});
