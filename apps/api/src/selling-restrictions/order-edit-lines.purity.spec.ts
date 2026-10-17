import * as fs from "fs";
import * as path from "path";

// SA-408b: order-edit-lines.ts is PURE (no Prisma, no Nest). Its one import, the unit-label
// normaliser, imports only the pure @routeflow/pricing package (unitNameKey), so nothing from @nestjs or
// @prisma can reach it transitively.
describe("order-edit-lines.ts stays Nest-free (SA-408b)", () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8");
  const imports = (src: string) => [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

  it("imports nothing from @nestjs or @prisma, and its normaliser imports only the pure pricing package", () => {
    expect(imports(read("order-edit-lines.ts"))).toEqual(["../orders/unit-label-norm"]);
    expect(imports(read("../orders/unit-label-norm.ts"))).toEqual(["@routeflow/pricing"]);
  });
});
