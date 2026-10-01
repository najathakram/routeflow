// The cart-merge section runs under an advisory lock; no DB here, so a pass-through.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));
jest.mock("../orders/oversell-policy", () => {
  const actual = jest.requireActual("../orders/oversell-policy");
  return { ...actual, resolveOversellAllowed: jest.fn(actual.resolveOversellAllowed) };
});
jest.mock("../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: class NotificationsService {},
}));

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
import { PolicyOversellReader } from "../orders/policy-oversell-reader";
import { resolveOversellAllowed } from "../orders/oversell-policy";

/**
 * WS9 call-site contract for the buyer portal (RED until the call-site PR): a buyer's standing-order
 * "Reorder" (`reorderFromTemplate`) resolves the oversell policy ONCE, before the template run, with
 * role CUSTOMER + the buyer customer's id and source "buyer" (never a staff role, never
 * "template_cron"), and hands the template service the resulting BOOLEAN (3rd arg; the 2nd stays isStaffRole=false) instead of the hard-wired
 * `false`. The cart "Reorder" paths (`addAllLow` -> `createOrder`) are never labelled template_cron.
 *
 * L-247: this builds BuyerController with every provider the existing BuyerController specs list
 * (buyer.controller.merge.spec.ts) plus PolicyOversellReader.
 */
const CTX = {
  customerId: "cust-1",
  tenantId: "tenant-xyz",
  tenantSlug: "acme",
  userId: null,
  customer: { id: "cust-1", businessName: "Buyer" },
};

describe("BuyerController oversell call sites", () => {
  let controller: BuyerController;
  let prisma: ReturnType<typeof createMockPrisma>;
  let templates: { generateOrder: jest.Mock };
  let orders: Record<string, jest.Mock>;
  let shelf: { lowItems: jest.Mock };
  let read: jest.Mock;
  const resolve = resolveOversellAllowed as unknown as jest.Mock;

  async function build(policy: unknown) {
    prisma = createMockPrisma();
    prisma.orderTemplate.findFirst.mockResolvedValue({ customerId: CTX.customerId });
    templates = { generateOrder: jest.fn().mockResolvedValue({ id: "o-1" }) };
    orders = {
      findActiveOrder: jest.fn().mockResolvedValue(null),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "order-fresh" }),
      findOne: jest.fn().mockResolvedValue({ id: "order-fresh" }),
    };
    shelf = { lowItems: jest.fn().mockResolvedValue([{ productId: "p1", qty: 2 }]) };
    read = jest.fn().mockResolvedValue(policy);
    resolve.mockClear();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuyerController],
      providers: [
        { provide: BuyerService, useValue: {} },
        { provide: BuyerCatalogService, useValue: {} },
        { provide: BuyerDashboardService, useValue: {} },
        { provide: ReplenishmentService, useValue: {} },
        { provide: ShelfService, useValue: shelf },
        { provide: StockAlertService, useValue: {} },
        { provide: PromotionsService, useValue: {} },
        { provide: OrdersService, useValue: orders },
        { provide: ChangeRequestsService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
        { provide: InvoicePdfService, useValue: {} },
        { provide: StatementService, useValue: {} },
        { provide: StatementPdfService, useValue: {} },
        { provide: CustomersService, useValue: {} },
        { provide: OrderTemplatesService, useValue: templates },
        { provide: AuthorizationsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: {} },
        { provide: PolicyOversellReader, useValue: { read } },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((_id, fn) => fn()), getOrNull: jest.fn().mockReturnValue(null) },
        },
      ],
    }).compile();
    controller = module.get(BuyerController);
  }

  it.each([
    ["backorder", true],
    ["off", false],
  ])(
    "reorderFromTemplate (policy %s): one resolve as CUSTOMER/buyer/customerId, boolean %s reaches generateOrder",
    async (policy, want) => {
      await build(policy);
      await controller.reorderFromTemplate("tpl-1", CTX);

      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith(
        expect.objectContaining({ read }),
        expect.objectContaining({
          tenantId: CTX.tenantId,
          role: "CUSTOMER",
          source: "buyer",
          customerId: CTX.customerId,
        }),
      );
      expect(read).toHaveBeenCalledTimes(1);
      // resolved BEFORE the template run starts
      expect(resolve.mock.invocationCallOrder[0]).toBeLessThan(
        templates.generateOrder.mock.invocationCallOrder[0],
      );
      expect(templates.generateOrder).toHaveBeenCalledTimes(1);
      expect(templates.generateOrder.mock.calls[0][0]).toBe("tpl-1");
      // (id, isStaffRole, allowOversell): the buyer channel stays BUYER (false) whatever the policy says
      expect(templates.generateOrder.mock.calls[0][1]).toBe(false);
      expect(templates.generateOrder.mock.calls[0][2]).toBe(want);
    },
  );

  it("a template that is not the buyer's is refused BEFORE any policy read", async () => {
    await build("backorder");
    prisma.orderTemplate.findFirst.mockResolvedValue({ customerId: "someone-else" });
    await expect(controller.reorderFromTemplate("tpl-1", CTX)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(templates.generateOrder).not.toHaveBeenCalled();
  });

  it("C7b: the cart Reorder (addAllLow -> createOrder) is placed as the CUSTOMER and is never labelled template_cron", async () => {
    await build("backorder");
    await controller.addAllLow(CTX);
    expect(orders.create).toHaveBeenCalledTimes(1);
    expect(orders.create.mock.calls[0][1]).toMatchObject({ role: "CUSTOMER" });
    for (const call of resolve.mock.calls) {
      expect(call[1].source).not.toBe("template_cron");
    }
  });

  it("reorderFromTemplate is never labelled template_cron (that source is true for every role)", async () => {
    await build("off");
    await controller.reorderFromTemplate("tpl-1", CTX);
    expect(resolve.mock.calls.length).toBeGreaterThan(0); // RED today: the controller never resolves
    for (const call of resolve.mock.calls) expect(call[1].source).toBe("buyer");
  });
});
