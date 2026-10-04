// The merge branch runs inside `withAdvisoryLock`, which opens its own `pg` connection —
// unreachable in a unit suite. Pass-through stand-in, as in ./buyer.controller.merge.spec.ts.
jest.mock("../common/db-locks", () => {
  class LockTimeoutError extends Error {}
  class LockUnavailableError extends Error {}
  return {
    withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
      acquired: true,
      value: await fn(),
    })),
    LockTimeoutError,
    LockUnavailableError,
  };
});

import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
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
import { FeatureConfigService } from "../billing/feature-config.service";
import { AddonService } from "../billing/addon.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { FulfilmentCapabilityService } from "../billing/fulfilment-capability.service";
import { BuyerCreateOrderDto } from "./dto/buyer-create-order.dto";

/**
 * Business profiles 1B: a shipping-only seller's customers order through the buyer portal.
 * `POST /buyer/orders` with no `fulfillPath` takes the seller's `portalDefault`; an explicit path
 * the seller's portal does not offer is the fixed coded 400 FULFILMENT_PATH_NOT_OFFERED. An UNSET
 * seller (portalMethods [], portalDefault null) is today exactly: the create call carries no
 * `fulfillPath` (OrdersService resolves customer default ?? ROUTE) and an explicit path is refused,
 * as the whitelisting ValidationPipe refuses it today.
 */
const CTX = {
  customerId: "cust-ship-1",
  tenantId: "tenant-ship",
  tenantSlug: "acme",
  userId: null,
  customer: { id: "cust-ship-1", businessName: "Acme Buyer" },
};
const ITEMS = [{ productId: "prod-1", qty: 2 }];

/** What the controller passes OrdersService.create today (pre-1B), for a forceNew order. */
const TODAY_CREATE_DTO = {
  items: [{ productId: "prod-1", qty: 2, boxes: undefined, pieces: undefined, notes: undefined }],
  notes: undefined,
  urgent: undefined,
  requestedDeliveryDate: undefined,
  status: "PENDING",
};

describe("POST /buyer/orders — the seller's portal fulfilment rule (business profiles 1B)", () => {
  let controller: BuyerController;
  let mode: string;
  let getEffectiveMode: jest.Mock;
  let ordersService: {
    findActiveOrder: jest.Mock;
    updateOrderItems: jest.Mock;
    applyBuyerMergeHeader: jest.Mock;
    mergeAllPendingForCustomer: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
  };

  beforeEach(async () => {
    mode = "unset";
    getEffectiveMode = jest.fn(async (_t: string, key: string) =>
      key === "fulfilment_model" ? mode : "unset",
    );
    ordersService = {
      findActiveOrder: jest.fn().mockResolvedValue(null),
      updateOrderItems: jest.fn().mockResolvedValue({}),
      applyBuyerMergeHeader: jest.fn().mockResolvedValue(undefined),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "ord-new" }),
      findOne: jest.fn().mockResolvedValue({ id: "ord-active" }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuyerController],
      providers: [
        oversellReaderOffProvider,
        FulfilmentCapabilityService,
        { provide: FeatureConfigService, useValue: { getEffectiveMode } },
        { provide: AddonService, useValue: { getActiveAddons: jest.fn().mockResolvedValue([]) } },
        {
          provide: FeatureOverrideService,
          useValue: { allActive: jest.fn().mockResolvedValue(new Map()) },
        },
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
        { provide: PrismaService, useValue: createMockPrisma() },
        { provide: SystemConfigService, useValue: {} },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((_id, fn) => fn()), getOrNull: jest.fn().mockReturnValue(null) },
        },
      ],
    }).compile();
    controller = module.get(BuyerController);
  });

  const place = (extra: Record<string, unknown> = {}) =>
    controller.createOrder({ items: ITEMS, forceNew: true, ...extra } as never, CTX as never);
  const createdDto = () => ordersService.create.mock.calls[0][0];
  const expectNotOffered = async (p: Promise<unknown>) => {
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    await p.catch((e: BadRequestException) =>
      expect(e.getResponse()).toEqual({
        code: "FULFILMENT_PATH_NOT_OFFERED",
        fulfillPath: expect.any(String),
        offered: expect.any(Array),
        message: "This seller doesn't offer that delivery method for portal orders.",
      }),
    );
  };

  describe("UNSET seller (every tenant today): before == after", () => {
    it("no path: the create call is byte-identical to today's (no fulfillPath key)", async () => {
      await place();
      expect(createdDto()).toEqual(TODAY_CREATE_DTO);
      expect("fulfillPath" in createdDto()).toBe(false);
    });

    it("an explicit path is refused, nothing is created (today the ValidationPipe refuses it)", async () => {
      await expectNotOffered(place({ fulfillPath: "ROUTE" }));
      await expectNotOffered(place({ fulfillPath: "SHIP" }));
      expect(ordersService.create).not.toHaveBeenCalled();
    });

    it("a failed mode read is unset: the order still goes through exactly as today", async () => {
      getEffectiveMode.mockRejectedValue(new Error("db down"));
      await place();
      expect(createdDto()).toEqual(TODAY_CREATE_DTO);
    });
  });

  describe("shipping-only seller (fulfilment_model = ship)", () => {
    beforeEach(() => {
      mode = "ship";
    });

    it("no path: the order is created as SHIP (portalDefault)", async () => {
      await place();
      expect(createdDto()).toEqual({ ...TODAY_CREATE_DTO, fulfillPath: "SHIP" });
    });

    it("explicit SHIP is accepted", async () => {
      await place({ fulfillPath: "SHIP" });
      expect(createdDto().fulfillPath).toBe("SHIP");
    });

    it("explicit ROUTE is the coded 400, nothing created", async () => {
      await expectNotOffered(place({ fulfillPath: "ROUTE" }));
      expect(ordersService.create).not.toHaveBeenCalled();
    });

    it("the refusal names the requested path and what the portal offers", async () => {
      const err = await place({ fulfillPath: "ROUTE" }).catch((e) => e);
      expect(err.getResponse()).toMatchObject({ fulfillPath: "ROUTE", offered: ["SHIP"] });
    });

    it("an explicit not-offered path is refused BEFORE a merge into the active order", async () => {
      ordersService.findActiveOrder.mockResolvedValue({ id: "ord-active", lineItems: [] });
      await expectNotOffered(
        controller.createOrder({ items: ITEMS, fulfillPath: "ROUTE" } as never, CTX as never),
      );
      expect(ordersService.findActiveOrder).not.toHaveBeenCalled();
      expect(ordersService.updateOrderItems).not.toHaveBeenCalled();
    });
  });

  describe("delivery + shipping seller (both)", () => {
    beforeEach(() => {
      mode = "both";
    });

    it("no path: ROUTE (portalDefault); explicit SHIP: SHIP", async () => {
      await place();
      expect(createdDto().fulfillPath).toBe("ROUTE");
      ordersService.create.mockClear();
      await place({ fulfillPath: "SHIP" });
      expect(createdDto().fulfillPath).toBe("SHIP");
    });
  });

  describe("own delivery only (delivery)", () => {
    it("explicit SHIP is the coded 400", async () => {
      mode = "delivery";
      await expectNotOffered(place({ fulfillPath: "SHIP" }));
    });
  });

  describe("PICKUP is untouched (no FulfillPath value exists for it)", () => {
    it("in store only: no path sends no fulfillPath (today's customer default ?? ROUTE)", async () => {
      mode = "pickup";
      await place();
      expect(createdDto()).toEqual(TODAY_CREATE_DTO);
    });

    it("in store + shipping: no path sends no fulfillPath; explicit SHIP is accepted", async () => {
      mode = "pickup_ship";
      await place();
      expect("fulfillPath" in createdDto()).toBe(false);
      ordersService.create.mockClear();
      await place({ fulfillPath: "SHIP" });
      expect(createdDto().fulfillPath).toBe("SHIP");
    });
  });
});

describe("BuyerCreateOrderDto.fulfillPath (whitelisting ValidationPipe, as main.ts runs it)", () => {
  const check = (body: Record<string, unknown>) =>
    validate(plainToInstance(BuyerCreateOrderDto, { items: ITEMS, ...body }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it("accepts ROUTE and SHIP (the server then applies the seller's portal rule)", async () => {
    expect(await check({ fulfillPath: "ROUTE" })).toHaveLength(0);
    expect(await check({ fulfillPath: "SHIP" })).toHaveLength(0);
  });

  it("refuses PICKUP and anything else (PICKUP is not a FulfillPath value)", async () => {
    expect(await check({ fulfillPath: "PICKUP" })).not.toHaveLength(0);
    expect(await check({ fulfillPath: "drone" })).not.toHaveLength(0);
  });

  it("omitting it stays valid", async () => {
    expect(await check({})).toHaveLength(0);
  });
});
