import "reflect-metadata";
import { buildProductListWhere } from "./product-list-where";

describe("buildProductListWhere: search matches the full name (SA-1216)", () => {
  it("also matches the family's name, so 'acme vape' finds the variant 'Blueberry'", () => {
    const where = buildProductListWhere({ search: "acme vape" } as any);
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { name: { contains: "acme vape", mode: "insensitive" } },
        { parent: { name: { contains: "acme vape", mode: "insensitive" } } },
      ]),
    );
  });
});
