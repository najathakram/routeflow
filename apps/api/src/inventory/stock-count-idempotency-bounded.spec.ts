import * as fs from "fs";
import * as path from "path";

/**
 * Row 354 (fix A), structural pin. `StockMovement` has no `reference` index, so the count's idempotency read must be
 * bounded by the counted products (the `productId` index). A bare `where: { reference }` here is an unbounded scan
 * of the tenant's ledger AND matches another product's movement; it fails this spec. The DB-lane spec
 * `sa767-count-idempotency-product-filter.db.spec.ts` proves the behaviour; this keeps the shape from regressing.
 */
describe("row 354: the count idempotency read names the counted products", () => {
  const src = fs.readFileSync(path.join(__dirname, "inventory.service.ts"), "utf8");
  const at = src.indexOf("const already = await tx.stockMovement.findMany(");

  it("the read exists once", () => {
    expect(at).toBeGreaterThan(0);
    expect(src.indexOf("const already = await tx.stockMovement.findMany(", at + 1)).toBe(-1);
  });

  it("its where carries `productId: { in: productIds }` next to the reference", () => {
    const body = src.slice(at, src.indexOf("});", at));
    expect(body).toMatch(/reference/);
    expect(body).toMatch(/productId:\s*\{\s*in:\s*productIds\s*\}/);
  });
});
