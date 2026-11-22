import "reflect-metadata";
import { buildProductListWhere } from "./product-list-where";

describe("buildProductListWhere: search matches the full name (SA-1216)", () => {
  it("also matches the family's name, so 'acme vape' finds the variant 'Blueberry'", () => {
    const where = buildProductListWhere({ search: "acme vape" } as any, { tenantId: "tenant-a" });
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { name: { contains: "acme vape", mode: "insensitive" } },
        {
          parent: {
            tenantId: "tenant-a",
            name: { contains: "acme vape", mode: "insensitive" },
          },
        },
      ]),
    );
  });

  it("a parent from another tenant is ignored: the family match carries the caller's tenant", () => {
    const where = buildProductListWhere({ search: "acme other parent" } as any, {
      tenantId: "tenant-a",
    });
    const parentClauses = where.OR.filter((c: any) => c.parent);
    expect(parentClauses).toHaveLength(1);
    // the one relation filter must pin the parent to tenant A, never match another tenant's parent name
    expect(parentClauses[0].parent.tenantId).toBe("tenant-a");
  });

  it("with no tenant there is no family match at all (it fails closed)", () => {
    const where = buildProductListWhere({ search: "acme other parent" } as any);
    expect(where.OR.some((c: any) => c.parent)).toBe(false);
    expect(where.OR).toEqual(
      expect.arrayContaining([{ name: { contains: "acme other parent", mode: "insensitive" } }]),
    );
  });
});
