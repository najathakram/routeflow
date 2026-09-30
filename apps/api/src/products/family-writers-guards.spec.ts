import { BadRequestException } from "@nestjs/common";
import { ChangeRequestType, UserRole } from "@prisma/client";
import { ChangeRequestsService } from "../orders/change-requests.service";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { RecurringInvoicesService } from "../recurring-invoices/recurring-invoices.service";
import { InventoryService } from "../inventory/inventory.service";
import { loadEditCatalog } from "../invoices/invoice-edit-plan";

/**
 * Opus #2881 B1: the writers the first WS8 cut skipped now REFUSE a FAMILY with 400 FAMILY_NOT_SELLABLE. Behavioural
 * probes (the structural tripwire in family-writers-tripwire.spec.ts pins that each call exists). Each service is built
 * with `Object.create(prototype)` + a stub prisma, so only the guard and what precedes it run.
 */
const FAMILY = { id: "fam-1", name: "Soda Family", kind: "FAMILY" };
const refused = async (p: Promise<unknown>) => {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(BadRequestException);
  expect((err as BadRequestException).getResponse()).toMatchObject({ code: "FAMILY_NOT_SELLABLE" });
};
const prismaWith = (delegates: Record<string, unknown>) => ({
  forTenant: () => delegates,
  getTenantId: () => "tenant-a",
});
const build = <T>(
  proto: { prototype: T },
  prisma: unknown,
  extra: Record<string, unknown> = {},
): T => Object.assign(Object.create(proto.prototype as object), { prisma, ...extra }) as T;

describe("the skipped line / stock writers now refuse a FAMILY (400 FAMILY_NOT_SELLABLE)", () => {
  it("change-request ADD_ITEM is refused at FILING time", async () => {
    const order = {
      id: "o1",
      status: "PENDING",
      customerId: "c1",
      routeRun: { status: "IN_PROGRESS" },
      lineItems: [],
    };
    const svc = build(
      ChangeRequestsService,
      prismaWith({
        order: { findUnique: jest.fn().mockResolvedValue(order) },
        product: { findFirst: jest.fn().mockResolvedValue(FAMILY) },
      }),
    );
    await refused(
      svc.create(
        "o1",
        { type: ChangeRequestType.ADD_ITEM, productId: FAMILY.id, qty: 1 } as never,
        { sub: "u1", role: UserRole.OPERATOR } as never,
      ),
    );
  });

  it("invoice PATCH (loadEditCatalog) refuses a FAMILY line", async () => {
    const db = { product: { findMany: jest.fn().mockResolvedValue([FAMILY]) } };
    await refused(loadEditCatalog(db, [{ productId: FAMILY.id }]));
  });

  it("standing order: addItem refuses a FAMILY", async () => {
    const svc = build(
      OrderTemplatesService,
      prismaWith({ product: { findUnique: jest.fn().mockResolvedValue(FAMILY) } }),
      { findOne: jest.fn().mockResolvedValue({ id: "t1" }) },
    );
    await refused(svc.addItem("t1", { productId: FAMILY.id, qty: 1 } as never));
  });

  it("recurring invoice template: the shared helper refuses a FAMILY (create and update both call it)", async () => {
    const svc = build(
      RecurringInvoicesService,
      prismaWith({ product: { findMany: jest.fn().mockResolvedValue([FAMILY]) } }),
    );
    await refused((svc as any).assertLinesSellable([{ productId: FAMILY.id }]));
    // a line with no product id is a free-text line: nothing to check
    await expect((svc as any).assertLinesSellable([{ productId: null }])).resolves.toBeUndefined();
  });

  it("inventory: recordPurchase and recordAdjustment refuse a FAMILY before any StockLot / StockMovement", async () => {
    const tenantTransaction = jest.fn();
    const svc = build(InventoryService, {
      ...prismaWith({ product: { findUnique: jest.fn().mockResolvedValue(FAMILY) } }),
      tenantTransaction,
    });
    await refused(
      svc.recordPurchase({ productId: FAMILY.id, quantity: 1, unitCost: 1 } as never, "u1"),
    );
    await refused(svc.recordAdjustment({ productId: FAMILY.id, quantity: 1 } as never, "u1"));
    expect(tenantTransaction).not.toHaveBeenCalled();
  });
});
