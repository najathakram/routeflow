import { readFileSync } from "fs";
import { join } from "path";
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
    await refused((svc as any).assertNoFamilyLines([{ productId: FAMILY.id }]));
    // a line with no product id is a free-text line: nothing to check
    await expect((svc as any).assertNoFamilyLines([{ productId: null }])).resolves.toBeUndefined();
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

  it("Opus #2881 B1': stock count (legacy + session + line scan) and cost-basis writes refuse a FAMILY", async () => {
    const tenantTransaction = jest.fn();
    const session = { id: "s1", status: "OPEN", lines: [{ productId: FAMILY.id }] };
    const svc = build(
      InventoryService,
      {
        ...prismaWith({
          product: {
            findMany: jest.fn().mockResolvedValue([FAMILY]),
            findFirst: jest.fn().mockResolvedValue(FAMILY),
            findUnique: jest.fn().mockResolvedValue(FAMILY),
          },
          stockCountSession: { findUnique: jest.fn().mockResolvedValue(session) },
          // SA-767 L-2.2: every line edit first asks whether the count is committing (no movements).
          stockMovement: { findFirst: jest.fn().mockResolvedValue(null) },
        }),
        tenantTransaction,
      },
      { loadEditableSession: jest.fn().mockResolvedValue(session) },
    );
    const items = [{ productId: FAMILY.id, countedQty: 5, unitCost: 1 }];
    await refused(svc.commitStockCount({ sessionId: "x", items } as never, "u1"));
    await refused(svc.commitStockCountSession("s1", {} as never, { sub: "u1" }));
    await refused(
      svc.upsertStockCountLine("s1", { productId: FAMILY.id, countedQty: 5 } as never, {
        sub: "u1",
      }),
    );
    await refused(svc.setCostBasis(FAMILY.id, { unitCost: 1 } as never, "u1"));
    await refused(svc.bulkSetCostBasis({ items } as never, "u1"));
    expect(tenantTransaction).not.toHaveBeenCalled();
  });

  it("the recurring template create AND update both call the shared guard helper (pinned: 2 call sites)", () => {
    const raw = readFileSync(
      join(__dirname, "../recurring-invoices/recurring-invoices.service.ts"),
      "utf8",
    );
    // comments stripped, like the tripwire: a comment mentioning the call must not count
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect((src.match(/this\.assertNoFamilyLines\(/g) ?? []).length).toBe(2);
    expect(src.indexOf("this.assertNoFamilyLines(")).toBeLessThan(
      src.indexOf("recurringInvoice.create("),
    );
  });
});
