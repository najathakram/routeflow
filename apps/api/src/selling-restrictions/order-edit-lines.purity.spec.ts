import * as fs from "fs";
import * as path from "path";

// SA-408b: order-edit-lines.ts is PURE (no Prisma, no Nest). Its imports are the write's pack-or-pieces decision
// (SA-1118 MUST-1, a module that imports nothing) and the unit-label normaliser, which imports only the pure
// @routeflow/pricing package (unitNameKey), so nothing from @nestjs or @prisma can reach it transitively.
describe("order-edit-lines.ts stays Nest-free (SA-408b)", () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8");
  const imports = (src: string) => [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

  it("imports nothing from @nestjs or @prisma, and its two imports are pure", () => {
    expect(imports(read("order-edit-lines.ts"))).toEqual([
      "../orders/buyer-denomination",
      "../orders/unit-label-norm",
    ]);
    expect(imports(read("../orders/buyer-denomination.ts"))).toEqual([]);
    expect(imports(read("../orders/unit-label-norm.ts"))).toEqual(["@routeflow/pricing"]);
  });
});
