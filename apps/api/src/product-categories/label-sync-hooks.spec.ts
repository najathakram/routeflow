/**
 * The two Product.category writers the DB lane (`label-sync.db.spec.ts`) does not drive: a new FAMILY row
 * (`ProductFamiliesService.createFamily`) and a variant created inside a stock transfer
 * (`InventoryService.createVariantRowInTx`, which copies its parent's category). Each must call the add-only
 * label sync with the category text it just wrote, on the SAME tx client, and a writer that sets no category
 * (a family's variants) must not.
 */
import { Prisma } from "@prisma/client";
import * as labelWriter from "./label-writer";
import { ProductFamiliesService } from "../products/product-families.service";
import { InventoryService } from "../inventory/inventory.service";
import { ACTOR, T, makeTx } from "../products/product-code-release.fake-tx";

describe("label sync hooks: families and stock-transfer variants", () => {
  let sync: jest.SpyInstance;
  beforeEach(() => {
    sync = jest
      .spyOn(labelWriter, "syncCategoryLabel")
      .mockResolvedValue({ addedCategoryId: null });
  });
  afterEach(() => jest.restoreAllMocks());

  function families() {
    const tx = makeTx({ products: [] });
    const prisma = {
      getTenantId: () => T,
      tenantTransaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
      forTenant: () => tx,
    };
    const service = new ProductFamiliesService(
      prisma as never,
      { emitProductUpdated: jest.fn() } as never,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { getEffectiveMode: jest.fn().mockResolvedValue("off") } as never,
    );
    return { service, tx };
  }
  const familyDto = (category?: string) =>
    ({
      family: { name: "Soda", pricePerUnit: "1.00", ...(category ? { category } : {}) },
      variants: [
        { name: "Cola", pricePerUnit: "2.00" },
        { name: "Lime", pricePerUnit: "2.00" },
      ],
    }) as never;

  it("createFamily syncs the FAMILY row's category once, in its tx, and never for the variants", async () => {
    const { service, tx } = families();
    const out = await service.createFamily(familyDto("Snacks"), ACTOR);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(tx, {
      tenantId: T,
      productId: out.family.id,
      text: "Snacks",
      actor: { id: ACTOR, name: null },
    });
  });

  it("createFamily without a category passes null text (a no-op sync), still once", async () => {
    const { service } = families();
    await service.createFamily(familyDto(), ACTOR);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][1].text).toBeNull();
  });

  it("createVariantRowInTx syncs the category the new variant copied from its parent", async () => {
    const created = { id: "v1", category: "Snacks" };
    const tx = {
      product: { create: jest.fn().mockResolvedValue(created) },
      auditLog: { create: jest.fn() },
    };
    const service = new InventoryService({ getTenantId: () => T } as never, {} as never);
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
      category: "Snacks",
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
    const out = await (service as any).createVariantRowInTx(tx, parent, "Salt");
    expect(out).toBe(created);
    expect(tx.product.create.mock.calls[0][0].data.category).toBe("Snacks");
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(tx, { tenantId: T, productId: "v1", text: "Snacks" });
  });
});
