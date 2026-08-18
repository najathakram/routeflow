import { Test } from "@nestjs/testing";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { OrderTemplatesService } from "./order-templates.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * W6b follow-up: the standing-order (reorder) path used to write orders via a
 * direct prisma.order.create() that never ran the regulated-item license guard,
 * so a license-gated line could be sold to an unverified customer. These specs
 * pin the fix: blocked lines are SKIPPED (spec §8), the rest is ordered, both
 * sides are notified, and a fully-gated template yields nothing.
 */
describe("OrderTemplatesService — regulated license guard on reorder", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let authGuard: { checkAuthorized: jest.Mock };
  let notifications: { sendToCustomer: jest.Mock; sendToUser: jest.Mock };
  let ordersService: { mergeAllPendingForCustomer: jest.Mock };

  const template = {
    id: "t1",
    customerId: "c1",
    name: "Weekly",
    isActive: true,
    items: [
      { productId: "p-tob", qty: 2, notes: null },
      { productId: "p-std", qty: 3, notes: null },
    ],
  };
  const products = [
    { id: "p-tob", pricePerUnit: 10, trackedCategoryId: "cat-tob" },
    { id: "p-std", pricePerUnit: 5, trackedCategoryId: null },
  ];

  beforeEach(async () => {
    prisma = createMockPrisma();
    authGuard = { checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }) };
    notifications = {
      sendToCustomer: jest.fn().mockResolvedValue(1),
      sendToUser: jest.fn().mockResolvedValue(1),
    };
    ordersService = { mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null) };

    const mod = await Test.createTestingModule({
      providers: [
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
        // settings.taxRate is stored as a PERCENT string — "10" is 10%.
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue("10") },
        },
        { provide: OrdersService, useValue: ordersService },
        { provide: AuthorizationGuardService, useValue: authGuard },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);

    prisma.orderTemplate.findUnique.mockResolvedValue(template);
    prisma.product.findMany.mockResolvedValue(products);
    prisma.order.create.mockImplementation((a: any) => Promise.resolve({ id: "o1", ...a.data }));
    prisma.user.findMany.mockResolvedValue([{ id: "op1" }]);
  });

  it("runs the guard with the resolved per-line tracked category", async () => {
    await service.generateOrder("t1");
    expect(authGuard.checkAuthorized).toHaveBeenCalledWith({
      customerId: "c1",
      lines: [{ trackedCategoryId: "cat-tob" }, { trackedCategoryId: null }],
    });
  });

  it("skips the blocked regulated line, orders the rest, and notifies both sides", async () => {
    authGuard.checkAuthorized.mockResolvedValue({
      blocked: [{ trackedCategoryId: "cat-tob", categoryName: "Tobacco", reason: "NO_AUTH" }],
    });

    const order = await service.generateOrder("t1");

    const createArg = prisma.order.create.mock.calls[0][0];
    const createdLines = createArg.data.lineItems.create;
    expect(createdLines).toHaveLength(1);
    expect(createdLines[0].productId).toBe("p-std");
    expect(createArg.data.subtotal).toBe(15); // 5 * 3 only — tobacco excluded
    expect(createArg.data.notes).toContain("skipped");
    expect(notifications.sendToCustomer).toHaveBeenCalledWith(
      "c1",
      expect.any(String),
      expect.stringContaining("Tobacco"),
    );
    expect(notifications.sendToUser).toHaveBeenCalledWith(
      "op1",
      expect.objectContaining({ title: expect.stringContaining("skipped") }),
    );
    expect(order).toMatchObject({ id: "o1" });
  });

  it("orders every line (snapshotting the regulated category + hasRegulated) when verified", async () => {
    authGuard.checkAuthorized.mockResolvedValue({ blocked: [] });
    await service.generateOrder("t1");
    const createData = prisma.order.create.mock.calls[0][0].data;
    const createdLines = createData.lineItems.create;
    expect(createdLines).toHaveLength(2);
    // The allowed regulated line snapshots its tracked category so it invoices
    // as regulated (split + ledger) rather than standard.
    const tob = createdLines.find((l: any) => l.productId === "p-tob");
    expect(tob.trackedCategoryId).toBe("cat-tob");
    expect(createData.hasRegulated).toBe(true);
    expect(notifications.sendToCustomer).not.toHaveBeenCalled();
  });

  it("creates nothing and throws when EVERY line is a license-gated category", async () => {
    prisma.orderTemplate.findUnique.mockResolvedValue({
      ...template,
      items: [{ productId: "p-tob", qty: 1, notes: null }],
    });
    authGuard.checkAuthorized.mockResolvedValue({
      blocked: [{ trackedCategoryId: "cat-tob", categoryName: "Tobacco", reason: "EXPIRED" }],
    });

    await expect(service.generateOrder("t1")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(notifications.sendToCustomer).toHaveBeenCalled(); // still notified about the skip
  });
});

/**
 * SECURITY regression (F2-003): the customer-reachable item-removal and
 * order-generation endpoints route through removeItemForUser /
 * generateOrderForUser, whose findOneForUser() ownership check must reject a
 * CUSTOMER operating on ANOTHER customer's template. Before the fix, any
 * CUSTOMER could strip items from or generate orders off any tenant's template.
 */
describe("OrderTemplatesService — template ownership (F2-003)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const template = {
    id: "t1",
    customerId: "c-owner",
    name: "Weekly",
    isActive: true,
    items: [{ id: "i1", productId: "p1", qty: 1, notes: null }],
    customer: { id: "c-owner", businessName: "Owner Cafe" },
  };
  const asCustomer = (sub: string) => ({ sub, role: "CUSTOMER" }) as any;
  const asOperator = { sub: "op-1", role: "OPERATOR" } as any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
        // settings.taxRate is stored as a PERCENT string — "10" is 10%.
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue("10") },
        },
        { provide: OrdersService, useValue: { mergeAllPendingForCustomer: jest.fn() } },
        {
          provide: AuthorizationGuardService,
          useValue: { checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }) },
        },
        {
          provide: NotificationsService,
          useValue: { sendToCustomer: jest.fn(), sendToUser: jest.fn() },
        },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);

    prisma.orderTemplate.findUnique.mockResolvedValue(template);
    prisma.orderTemplateItem.findFirst.mockResolvedValue(template.items[0]);
    prisma.orderTemplateItem.delete.mockResolvedValue(template.items[0]);
    prisma.product.findMany.mockResolvedValue([{ id: "p1", pricePerUnit: 5 }]);
    prisma.order.create.mockImplementation((a: any) => Promise.resolve({ id: "o1", ...a.data }));
    prisma.user.findMany.mockResolvedValue([]);
  });

  it("a CUSTOMER who does not own the template cannot remove its items", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "c-attacker" });

    await expect(service.removeItemForUser("t1", "i1", asCustomer("u-attacker"))).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.orderTemplateItem.delete).not.toHaveBeenCalled();
  });

  it("a CUSTOMER who does not own the template cannot generate orders from it", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "c-attacker" });

    await expect(service.generateOrderForUser("t1", asCustomer("u-attacker"))).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("a CUSTOMER JWT with no customer record in this tenant is rejected", async () => {
    prisma.customer.findFirst.mockResolvedValue(null); // cross-tenant token

    await expect(service.removeItemForUser("t1", "i1", asCustomer("u-foreign"))).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.orderTemplateItem.delete).not.toHaveBeenCalled();
  });

  it("the OWNING customer can still remove items", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "c-owner" });

    const result = await service.removeItemForUser("t1", "i1", asCustomer("u-owner"));
    expect(result).toEqual({ success: true });
    expect(prisma.orderTemplateItem.delete).toHaveBeenCalledWith({ where: { id: "i1" } });
  });

  it("an OPERATOR bypasses the ownership check (staff manage all templates)", async () => {
    const result = await service.removeItemForUser("t1", "i1", asOperator);
    expect(result).toEqual({ success: true });
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });
});
