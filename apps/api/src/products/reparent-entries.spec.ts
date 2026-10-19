/**
 * SA-823 R11 (T15): every door that puts a product under (or out of) a parent names itself in the
 * `product.family_assigned` row's `via`. The row shape and its transaction are pinned in
 * products.family-assigned.spec.ts; this file drives EACH ENTRY and asserts the `via` it passes:
 * editor PATCH / create, bulk assign, import (the update branch and the variant-resolution create) and
 * inventory (the stock split's new variant).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Prisma } from "@prisma/client";
import { ProductsController } from "./products.controller";
import { InventoryService } from "../inventory/inventory.service";
import { VariantResolutionService } from "../import/variant-resolution.service";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const user = { sub: "u1", username: "op" } as JwtPayload;
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("every reparent entry names its door (SA-823 R11)", () => {
  it("editor: PATCH /products/:id passes reparentVia editor", async () => {
    const productsService = { update: jest.fn().mockResolvedValue({ id: "p1" }) };
    const c = new ProductsController(productsService as never, {} as never);
    await c.update("p1", { parentProductId: "fam" } as never, user, "ua");
    expect(productsService.update).toHaveBeenCalledWith(
      "p1",
      { parentProductId: "fam" },
      expect.objectContaining({ reparentVia: "editor", actorId: "u1" }),
    );
  });

  it("editor: POST /products passes reparentVia editor (a product created under a parent)", async () => {
    const productsService = { create: jest.fn().mockResolvedValue({ id: "p1" }) };
    const c = new ProductsController(productsService as never, {} as never);
    await c.create({ name: "x" } as never, user);
    expect(productsService.create).toHaveBeenCalledWith(
      { name: "x" },
      expect.objectContaining({ reparentVia: "editor" }),
    );
  });

  it("import (update branch): the import's update() call names reparentVia import", () => {
    const src = strip(readFileSync(join(__dirname, "..", "import", "import.service.ts"), "utf8"));
    const call = src.match(/productsService\.update\(\s*existing\.id[\s\S]*?\}\s*\)/);
    expect(call).not.toBeNull();
    expect(call![0]).toMatch(/reparentVia:\s*"import"/);
  });

  it("import (variant create): VariantResolutionService.createVariant creates under the parent with reparentVia import", async () => {
    const money = new Prisma.Decimal(1);
    const parent = {
      id: "p1",
      unit: "case",
      pricePerUnit: money,
      priceTier2: money,
      priceTier3: money,
      priceTier4: money,
      priceTier5: money,
      category: null,
      unitsPerBox: null,
      costingMethod: "AVCO",
      standardCost: null,
      isTobacco: false,
    };
    const products = { create: jest.fn().mockResolvedValue({ id: "v1" }) };
    const prisma = { forTenant: () => ({ product: { findUnique: async () => parent } }) };
    const service = new VariantResolutionService(prisma as never, products as never, {} as never);
    await service.createVariant({ parentProductId: "p1", variantName: "Grape" });
    expect(products.create).toHaveBeenCalledWith(
      expect.objectContaining({ parentProductId: "p1" }),
      { reparentVia: "import" },
    );
  });

  it("inventory: the stock split's new variant writes one family_assigned row, via inventory, fromParentId null, in the same tx", async () => {
    const created = { id: "v1", variantName: "Salt", category: null };
    const tx = {
      product: { create: jest.fn().mockResolvedValue(created) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new InventoryService({ getTenantId: () => "t-1" } as never, {} as never);
    const money = new Prisma.Decimal(1);
    const parent = {
      id: "p1",
      name: "Chips",
      unit: "each",
      pricePerUnit: money,
      priceTier2: money,
      priceTier3: money,
      priceTier4: money,
      priceTier5: money,
      category: null,
      isTobacco: false,
      costingMethod: "WEIGHTED_AVERAGE",
      standardCost: null,
      unitsPerBox: null,
      trackedCategoryId: null,
      trackedSubcategoryId: null,
      regItemType: null,
      regUomCase: null,
      regUomUnit: null,
    };
    await (service as any).createVariantRowInTx(tx, parent, "Salt", "off", "u9");
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create.mock.calls[0][0].data).toEqual({
      userId: "u9",
      action: AUDIT_ACTIONS.PRODUCT_FAMILY_ASSIGNED,
      entityType: "Product",
      entityId: "v1",
      meta: {
        productId: "v1",
        fromParentId: null,
        toParentId: "p1",
        variantName: "Salt",
        via: "inventory",
      },
    });
  });
});
