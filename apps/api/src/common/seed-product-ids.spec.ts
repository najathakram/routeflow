import { readFileSync } from "fs";
import { join } from "path";
import {
  assertNoLegacySeedProducts,
  LegacySeedProductsError,
} from "../../prisma/seed-legacy-products";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const seed = readFileSync(join(__dirname, "../../prisma/seed.ts"), "utf8");

describe("seed product ids (row 745)", () => {
  it("every seeded product id is a UUID (the counter DTO requires @IsUUID productId)", () => {
    const start = seed.indexOf("const productDefs = [");
    const end = seed.indexOf("];", start);
    const ids = [...seed.slice(start, end).matchAll(/^\s+id: "([^"]+)"/gm)].map((m) => m[1]);
    expect(ids).toHaveLength(15);
    expect(ids.filter((id) => !UUID.test(id))).toEqual([]);
  });

  it("no stock or order reference still points at a seed-prod-NN id", () => {
    expect(seed.match(/seed-prod-\d+/g) ?? []).toEqual([]);
  });

  it("seed.ts runs the legacy-row guard before the first product upsert", () => {
    const guard = seed.indexOf("assertNoLegacySeedProducts(prisma");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(seed.indexOf("prisma.product.upsert"));
  });

  it("the guard throws LegacySeedProductsError (code + ids) when old-id rows hold the SKUs", async () => {
    const defs = [{ id: "11111111-1111-4111-8111-111111111111", sku: "SKU-1" }];
    const findMany = jest.fn().mockResolvedValue([{ id: "seed-prod-01", sku: "SKU-1" }]);
    const err = await assertNoLegacySeedProducts(
      { product: { findMany } } as never,
      "t1",
      defs,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LegacySeedProductsError);
    expect((err as LegacySeedProductsError).code).toBe("LEGACY_SEED_PRODUCTS");
    expect((err as LegacySeedProductsError).legacyIds).toEqual(["seed-prod-01"]);
    // It looks only for rows holding the seeded SKUs under ids that are NOT the seeded ids.
    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", sku: { in: ["SKU-1"] }, id: { notIn: [defs[0].id] } },
      select: { id: true, sku: true },
    });
  });

  it("the guard resolves when no legacy rows exist", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    await expect(
      assertNoLegacySeedProducts({ product: { findMany } } as never, "t1", [{ id: "a", sku: "S" }]),
    ).resolves.toBeUndefined();
  });
});
