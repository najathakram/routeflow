import "reflect-metadata";
import { buildProductListWhere } from "./product-list-where";

describe("buildProductListWhere: ids (P-21)", () => {
  it("matches exactly the ids, pinned to the caller's tenant, with no isActive default", () => {
    const where = buildProductListWhere({ ids: ["id-1", "id-2"] } as any, { tenantId: "tenant-a" });
    expect(where.id).toEqual({ in: ["id-1", "id-2"] });
    expect(where.tenantId).toBe("tenant-a");
    expect(where).not.toHaveProperty("isActive");
  });

  it("without ids it adds no id clause", () => {
    const where = buildProductListWhere({} as any, { tenantId: "tenant-a" });
    expect(where).not.toHaveProperty("id");
  });
});
