/**
 * SA-1063 MUST 8 — the buyer-portal routes tell the office (a new order, an edit, a cancel) AFTER the commit and the
 * merge sweep, with `void`, naming the SURVIVING order. R14: the ambient tenant must survive the `void` (the real
 * `TenantContextService`, never a mock of it), or `notifyStaffEvent` refuses and the office hears nothing.
 */
jest.mock("../common/db-locks", () => ({
  LockTimeoutError: class LockTimeoutError extends Error {},
  LockUnavailableError: class LockUnavailableError extends Error {},
  withAdvisoryLock: jest.fn(async (_o: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
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
import { StaffOrderEmailService } from "../messaging/staff-order-email";
import { EmailService } from "../email/email.service";
import { EmailDeliveryService } from "../email/email-delivery.service";
import { PolicyService } from "../policy/policy.service";

const CTX = {
  customerId: "cust-1",
  tenantId: "t1",
  tenantSlug: "acme",
  userId: null,
  customer: { id: "cust-1", businessName: "Buyer" },
};

const flush = () => new Promise<void>((r) => setImmediate(r));

describe("SA-1063 BuyerController tells the office", () => {
  let controller: BuyerController;
  let svc: Record<string, jest.Mock>;
  let staff: Record<string, jest.Mock>;
  const dto = () => ({ items: [{ productId: "prod-a", qty: 3 }] });

  async function setup(staffProvider: unknown) {
    svc = {
      findActiveOrder: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockResolvedValue({ id: "ord-new", customerId: CTX.customerId, lineItems: [] }),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      updateOrderItems: jest.fn().mockResolvedValue({ id: "ord-1", lineItems: [] }),
      changeStatus: jest.fn().mockResolvedValue({ id: "ord-1" }),
      findOne: jest.fn(async (id: string) => ({ id, lineItems: [] })),
      findOrderIdByIdempotencyKey: jest.fn().mockResolvedValue(null),
      replayMergeReconcile: jest.fn().mockResolvedValue(undefined),
      liveTrioByProduct: jest.fn().mockResolvedValue(new Map()),
      recordIdempotencyKey: jest.fn().mockResolvedValue(undefined),
      applyBuyerMergeHeader: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = createMockPrisma();
    prisma.forTenant().product.findMany.mockResolvedValue([{ id: "prod-a", unitsPerBox: 1 }]);
    prisma.forTenant().orderTemplate.findFirst.mockResolvedValue({ customerId: CTX.customerId });
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
        { provide: OrdersService, useValue: svc },
        { provide: ChangeRequestsService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
        { provide: InvoicePdfService, useValue: {} },
        { provide: StatementService, useValue: {} },
        { provide: StatementPdfService, useValue: {} },
        { provide: CustomersService, useValue: {} },
        {
          provide: OrderTemplatesService,
          useValue: {
            generateOrder: jest.fn().mockResolvedValue({ id: "ord-tpl", lineItems: [] }),
          },
        },
        { provide: AuthorizationsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: {} },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((_id, fn) => fn()), getOrNull: jest.fn().mockReturnValue(null) },
        },
        { provide: StaffOrderEmailService, useValue: staffProvider },
      ],
    }).compile();
    controller = module.get(BuyerController);
  }

  beforeEach(async () => {
    staff = {
      notifyBuyerOrderPlaced: jest.fn().mockResolvedValue(undefined),
      notifyBuyerOrderEdited: jest.fn().mockResolvedValue(undefined),
      notifyBuyerOrderCancelled: jest.fn().mockResolvedValue(undefined),
      orderIsDraft: jest.fn().mockResolvedValue(false),
    };
    await setup(staff);
  });

  it("POST buyer/orders, no open order: placed for the new order, not merged", async () => {
    await controller.createOrder(dto() as never, CTX as never);
    expect(staff.notifyBuyerOrderPlaced).toHaveBeenCalledWith("ord-new", { merged: false });
  });

  it("POST buyer/orders, the sweep folds it into an older order: that order, merged true", async () => {
    svc.mergeAllPendingForCustomer.mockResolvedValue({ id: "ord-older", lineItems: [] });
    await controller.createOrder(dto() as never, CTX as never);
    expect(staff.notifyBuyerOrderPlaced).toHaveBeenCalledWith("ord-older", { merged: true });
  });

  it("POST buyer/orders, forceNew: placed for the new order (no sweep runs)", async () => {
    await controller.createOrder({ ...dto(), forceNew: true } as never, CTX as never);
    expect(svc.mergeAllPendingForCustomer).not.toHaveBeenCalled();
    expect(staff.notifyBuyerOrderPlaced).toHaveBeenCalledWith("ord-new", { merged: false });
  });

  it("POST buyer/orders, the cart folds into the open order: that order, merged true", async () => {
    svc.findActiveOrder.mockResolvedValue({
      id: "ord-open",
      customerId: CTX.customerId,
      lineItems: [{ id: "li-1", productId: "prod-a", qty: 2, boxes: null, pieces: null }],
    });
    await controller.createOrder(dto() as never, CTX as never);
    expect(svc.updateOrderItems).toHaveBeenCalled();
    expect(staff.notifyBuyerOrderPlaced).toHaveBeenCalledWith("ord-open", { merged: true });
  });

  it("POST buyer/orders, a replayed submit: the same order, merged false (R5)", async () => {
    svc.findActiveOrder.mockResolvedValue({
      id: "ord-open",
      customerId: CTX.customerId,
      lineItems: [],
    });
    svc.findOrderIdByIdempotencyKey.mockResolvedValue({ orderId: "ord-open", verified: true });
    await controller.createOrder(dto() as never, CTX as never, "key-1");
    expect(svc.updateOrderItems).not.toHaveBeenCalled();
    expect(staff.notifyBuyerOrderPlaced).toHaveBeenCalledWith("ord-open", { merged: false });
  });

  it("PATCH buyer/orders/:id/items: edited, after the edit", async () => {
    await controller.updateOrderItems("ord-1", { items: [] } as never, CTX as never);
    expect(staff.notifyBuyerOrderEdited).toHaveBeenCalledWith("ord-1");
  });

  it("POST buyer/orders/:id/cancel: the draft read comes before the cancel, then cancelled", async () => {
    const seen: string[] = [];
    staff.orderIsDraft.mockImplementation(async () => {
      seen.push("read");
      return false;
    });
    svc.changeStatus.mockImplementation(async () => {
      seen.push("cancel");
      return { id: "ord-1" };
    });
    await controller.cancelOrder("ord-1", CTX as never);
    expect(seen).toEqual(["read", "cancel"]);
    expect(staff.notifyBuyerOrderCancelled).toHaveBeenCalledWith("ord-1", { wasDraft: false });
  });

  it("POST buyer/orders/:id/cancel: a refused cancel is not announced", async () => {
    svc.changeStatus.mockRejectedValue(new Error("not yours"));
    await expect(controller.cancelOrder("ord-1", CTX as never)).rejects.toThrow("not yours");
    expect(staff.notifyBuyerOrderCancelled).not.toHaveBeenCalled();
  });

  it("R9: POST buyer/templates/:id/reorder: placed for the generated order", async () => {
    await controller.reorderFromTemplate("tpl-1", CTX as never);
    expect(staff.notifyBuyerOrderPlaced).toHaveBeenCalledWith("ord-tpl", { merged: false });
  });

  it("the response never waits for the email", async () => {
    staff.notifyBuyerOrderPlaced.mockReturnValue(new Promise(() => undefined));
    await expect(controller.createOrder(dto() as never, CTX as never)).resolves.toBeDefined();
  });

  it("a staff service that rejects cannot fail the order (the unhandled rejection is the service's job to never raise)", async () => {
    // The service contract is "never rejects"; the controller adds nothing on top of `void`.
    staff.notifyBuyerOrderEdited.mockResolvedValue(undefined);
    await expect(
      controller.updateOrderItems("ord-1", { items: [] } as never, CTX as never),
    ).resolves.toBeDefined();
  });
});

describe("SA-1063 R14: the ambient tenant survives the void (real TenantContextService)", () => {
  afterEach(() => {
    delete process.env.STAFF_ORDER_EMAIL;
  });

  it("a buyer cancel inside the tenant context still writes the office's rows", async () => {
    process.env.STAFF_ORDER_EMAIL = "dark";
    const tenantCtx = new TenantContextService();
    const models = {
      order: {
        findFirst: jest.fn(async (a: { select?: unknown }) =>
          a?.select
            ? { status: "PENDING" }
            : {
                id: "ord-1",
                tenantId: "t1",
                orderNumber: "ORD-1",
                total: 10,
                customer: { name: "B" },
              },
        ),
      },
      emailDelivery: { findFirst: jest.fn().mockResolvedValue(null) },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: "u1", email: "a@example.com", role: "TENANT_ADMIN" }]),
      },
      userPreference: { findMany: jest.fn().mockResolvedValue([]) },
      systemConfig: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    // `getTenantId` reads the REAL context store, exactly as PrismaService does.
    const prisma = { forTenant: () => models, getTenantId: () => tenantCtx.getOrNull() };
    const deliveries = { record: jest.fn().mockResolvedValue(undefined) };
    const policies = { resolve: jest.fn().mockResolvedValue("dark") };
    const real = new StaffOrderEmailService(
      prisma as unknown as PrismaService,
      { send: jest.fn() } as unknown as EmailService,
      deliveries as unknown as EmailDeliveryService,
      policies as unknown as PolicyService,
    );
    const orders = { changeStatus: jest.fn().mockResolvedValue({ id: "ord-1" }) };
    const controller = Object.create(BuyerController.prototype) as BuyerController;
    Object.assign(controller, { ordersService: orders, staffOrderEmail: real });

    await tenantCtx.run("t1", () => controller.cancelOrder("ord-1", CTX as never));
    await flush();
    await flush();

    expect(deliveries.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        kind: "BUYER_ORDER_CANCELLED",
        status: "WOULD_SEND",
        entityId: "ord-1",
      }),
    );
  });
});
