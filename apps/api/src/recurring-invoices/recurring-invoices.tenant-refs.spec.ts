import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { NotificationsService } from "../notifications/notifications.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { NO_PRICE_RIGHTS } from "../common/testing/no-rights-actor";
import { EntitlementsService } from "../billing/entitlements.service";

/** What a tenant-scoped read does: only this tenant's own rows come back for an id list. */
const ownRows = (owned: string[]) => async (args: { where: { id: { in: string[] } } }) =>
  args.where.id.in
    .filter((id) => owned.includes(id))
    .map((id) => ({ id, kind: "SIMPLE", pricePerUnit: 5 })); // 5 is the items' typed price: at the baseline, no rights needed

// 681 (R5-5) sites 5 and 6: a recurring template stores its customer (create only: update never writes
// customerId) and every item's productId. Each must resolve in the caller's tenant before the write.
describe("RecurringInvoicesService — tenant refs (681 sites 5, 6)", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const item = (productId: string) => ({ description: "Line", productId, qty: 1, unitPrice: 5 });
  const base = {
    frequency: "MONTHLY",
    dayOfMonth: 1,
    nextRunAt: "2026-12-01T00:00:00Z",
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.customer.findMany.mockImplementation(ownRows(["cust-a"]));
    prisma.product.findMany.mockImplementation(ownRows(["prod-a"]));
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-a" });
    prisma.recurringInvoice.findUnique.mockResolvedValue({
      id: "ri-1",
      customerId: "cust-a",
      items: [],
    });
    prisma.recurringInvoice.create.mockResolvedValue({ id: "ri-1" });
    prisma.recurringInvoice.update.mockResolvedValue({ id: "ri-1" });
    const mod = await Test.createTestingModule({
      providers: [
        RecurringInvoicesService,
        { provide: EntitlementsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: {} },
        { provide: InvoicesService, useValue: { create: jest.fn() } },
        { provide: SellingRestrictionsService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
      ],
    }).compile();
    service = mod.get(RecurringInvoicesService);
  });

  describe("site 5 — create", () => {
    const create = (customerId: string, productId: string) =>
      service.create({ ...base, customerId, items: [item(productId)] } as never, NO_PRICE_RIGHTS);

    it("another tenant's product on an item is a 404 and no template is written", async () => {
      const err = await create("cust-a", "prod-b").catch((e) => e);
      expect(prisma.recurringInvoice.create).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe("Product not found");
    });

    it("another tenant's customer is a 404 and no template is written", async () => {
      const err = await create("cust-b", "prod-a").catch((e) => e);
      expect(prisma.recurringInvoice.create).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe("Customer not found");
    });

    it("control: this tenant's customer and product write the template", async () => {
      await create("cust-a", "prod-a");
      expect(prisma.recurringInvoice.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("site 6 — update (items replace)", () => {
    const update = (productId: string) =>
      service.update("ri-1", { items: [item(productId)] } as never, NO_PRICE_RIGHTS);

    it("another tenant's product on a replacement item is a 404; the lines are not deleted or rewritten", async () => {
      const err = await update("prod-b").catch((e) => e);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(prisma.recurringInvoiceItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.recurringInvoice.update).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe("Product not found");
    });

    it("control: this tenant's product replaces the lines", async () => {
      await update("prod-a");
      expect(prisma.recurringInvoice.update).toHaveBeenCalledTimes(1);
    });

    it("a header-only update (no items) reads no product", async () => {
      await service.update("ri-1", { notes: "x" } as never, NO_PRICE_RIGHTS);
      expect(prisma.product.findMany).not.toHaveBeenCalled();
      expect(prisma.recurringInvoice.update).toHaveBeenCalledTimes(1);
    });
  });
});
