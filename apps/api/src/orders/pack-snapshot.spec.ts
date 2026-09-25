import * as fs from "fs";
import * as path from "path";
import { BadRequestException } from "@nestjs/common";
import { packForCreateLine } from "./pack-snapshot";

/**
 * D-20 (#1808, SA-304): the copier C8 hand-off. `approveNextDelivery` passes the SOURCE line's pack to
 * `OrdersService.create` as an INTERNAL option; create() splits and prices that one line at it, not at the live pack.
 */
describe("packForCreateLine", () => {
  it("no snapshot for the product: the LIVE pack decides (a new sale is unchanged)", () => {
    expect(packForCreateLine("p", 6, undefined, ["p"])).toBe(6);
    expect(packForCreateLine("p", 6, { other: 12 }, ["p"])).toBe(6);
  });

  it("a snapshot wins over the live pack (12 sold, product since repacked to 6)", () => {
    expect(packForCreateLine("p", 6, { p: 12 }, ["p", "q"])).toBe(12);
  });

  it("a product on more than one draft line is REFUSED, never resolved by first match (SA-030/036)", () => {
    expect(() => packForCreateLine("p", 6, { p: 12 }, ["p", "p"])).toThrow(BadRequestException);
    expect(() => packForCreateLine("p", 6, { p: 12 }, ["p", "p"])).toThrow(/more than one line/);
    // a duplicate of a product WITHOUT a snapshot is nobody's business here
    expect(packForCreateLine("q", 6, { p: 12 }, ["p", "q", "q"])).toBe(6);
  });

  it.each([1, 0, -12, 1.5, Number.NaN])(
    "a snapshot of %s is not a real box size and is refused",
    (bad) => {
      expect(() => packForCreateLine("p", 6, { p: bad }, ["p"])).toThrow(BadRequestException);
    },
  );
});

describe("the hand-off is INTERNAL and structurally intact (contract pin for C8)", () => {
  const SRC = path.resolve(__dirname, "..");
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(full, out);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
    }
    return out;
  };

  it("no DTO, controller or other file names packSnapshots: no HTTP route can pass it", () => {
    const allowed = new Set([
      "orders/pack-snapshot.ts",
      "orders/orders.service.ts",
      "orders/change-requests.service.ts",
      "common/testing/copier-contract/copier-registry.ts", // a comment naming the hand-off, no code
    ]);
    const offenders = walk(SRC)
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .filter((rel) => !allowed.has(rel) && read(rel).includes("packSnapshots"));
    expect(offenders).toEqual([]);
    // and the DTO the controller binds has no such field
    expect(read("orders/dto/create-order.dto.ts")).not.toMatch(/packSnapshot|unitsPerBox/);
  });

  it("approveNextDelivery passes the source pack to create(), and create() feeds it through packForCreateLine (fails on the pre-fix shape)", () => {
    const cr = read("orders/change-requests.service.ts");
    const method = cr.slice(cr.indexOf("private async approveNextDelivery("));
    expect(method).toContain("sourcePack = upb");
    expect(method).toMatch(/packSnapshots:\s*\{\s*\[productId\]:\s*sourcePack\s*\}/);
    const orders = read("orders/orders.service.ts");
    expect(orders).toMatch(
      /packForCreateLine\(\s*item\.productId,[\s\S]{0,200}options\.packSnapshots/,
    );
    // and the line's split/price no longer reads the live pack directly at that site
    const createBody = orders.slice(orders.indexOf("  async create("));
    const firstUpb = createBody.indexOf("const upb = ");
    expect(createBody.slice(firstUpb, firstUpb + 120)).toContain("packForCreateLine(");
  });
});
