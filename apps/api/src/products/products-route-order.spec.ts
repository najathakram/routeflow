import { readFileSync } from "fs";
import { join } from "path";

/**
 * Opus #2856 m6: `PATCH /products/portal-visibility` (bulk) must be registered BEFORE `PATCH /products/:id`, or the
 * `:id` route captures it (it would 400 on the non-whitelisted body). Express/Nest match in controller registration
 * order, so the order of `controllers: [...]` in the module IS the contract.
 */
describe("ProductsModule controller order", () => {
  const src = readFileSync(join(__dirname, "products.module.ts"), "utf8");
  const block = src.slice(
    src.indexOf("controllers: ["),
    src.indexOf("]", src.indexOf("controllers: [")),
  );

  it("ProductPortalVisibilityController is registered before ProductsController", () => {
    expect(block.indexOf("ProductPortalVisibilityController")).toBeGreaterThanOrEqual(0);
    expect(block.indexOf("ProductPortalVisibilityController")).toBeLessThan(
      block.indexOf("ProductsController"),
    );
  });

  it("ProductFamiliesController is registered before ProductsController (GET sku-available must not be captured by GET :id)", () => {
    expect(block.indexOf("ProductFamiliesController")).toBeGreaterThanOrEqual(0);
    expect(block.indexOf("ProductFamiliesController")).toBeLessThan(
      block.indexOf("ProductsController"),
    );
  });

  it("the bulk route is a literal path segment, the single route a param: the two shapes that collide", () => {
    const bulk = readFileSync(join(__dirname, "product-portal-visibility.controller.ts"), "utf8");
    expect(bulk).toMatch(/@Patch\("portal-visibility"\)/);
    const products = readFileSync(join(__dirname, "products.controller.ts"), "utf8");
    expect(products).toMatch(/@Patch\(":id"\)/);
  });
});
