import * as fs from "fs";
import * as path from "path";
import { BadRequestException } from "@nestjs/common";
import { PriceType } from "@prisma/client";
import { sourceLineFor, type SourceLine } from "./source-line";
import { optionsPassedKeys } from "../common/testing/copier-contract/copier-ast";

/**
 * D-20 (#1808, SA-304 / SA-330): the copier C8 hand-off. `approveNextDelivery` passes the SOURCE line's price (always)
 * and pack (when box-aware) to `OrdersService.create` as an INTERNAL option; create() splits and prices that one line
 * at them, not at the live pack and today's price.
 */
describe("sourceLineFor", () => {
  const src = (over: Partial<SourceLine> = {}): SourceLine => ({
    unitsPerBox: 12,
    unitPrice: 36,
    priceType: PriceType.STANDARD,
    originalPrice: null,
    overrideReason: null,
    overriddenBy: null,
    ...over,
  });

  it("no source line for the product: undefined, so the LIVE pack and today's price decide (a new sale is unchanged)", () => {
    expect(sourceLineFor("p", undefined, [{ productId: "p" }])).toBeUndefined();
    expect(sourceLineFor("p", { other: src() }, [{ productId: "p" }])).toBeUndefined();
  });

  it("returns the source line (pack, price, type, original price) for the product", () => {
    const line = src({ priceType: PriceType.DISCOUNTED, originalPrice: 40, unitPrice: 30 });
    expect(sourceLineFor("p", { p: line }, [{ productId: "p" }, { productId: "q" }])).toBe(line);
    // a bare selling-unit line carries its price but no pack
    expect(
      sourceLineFor("p", { p: src({ unitsPerBox: null }) }, [{ productId: "p" }])?.unitsPerBox,
    ).toBeNull();
  });

  it("a product on more than one draft line is REFUSED, never resolved by first match (SA-030/036)", () => {
    const items = [{ productId: "p" }, { productId: "p" }];
    expect(() => sourceLineFor("p", { p: src() }, items)).toThrow(BadRequestException);
    expect(() => sourceLineFor("p", { p: src() }, items)).toThrow(/more than one line/);
    // a duplicate of a product WITHOUT a source line is nobody's business here
    expect(
      sourceLineFor("q", { p: src() }, [
        { productId: "p" },
        { productId: "q" },
        { productId: "q" },
      ]),
    ).toBeUndefined();
  });

  it.each([1, 0, -12, 1.5, Number.NaN])(
    "a pack of %s is not a real box size and is refused",
    (bad) => {
      expect(() =>
        sourceLineFor("p", { p: src({ unitsPerBox: bad }) }, [{ productId: "p" }]),
      ).toThrow(BadRequestException);
    },
  );

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("a price of %s is refused", (bad) => {
    expect(() => sourceLineFor("p", { p: src({ unitPrice: bad }) }, [{ productId: "p" }])).toThrow(
      BadRequestException,
    );
  });
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

  it("no DTO, controller or other file names sourceLines: no HTTP route can pass a line's pack or price", () => {
    const allowed = new Set([
      "orders/source-line.ts",
      "orders/orders.service.ts",
      "orders/order-create-options.ts", // the INTERNAL options type of create(): names the hand-off, no route
      "orders/change-requests.service.ts",
      "common/testing/copier-contract/copier-registry.ts", // comments naming the hand-off, no code
      "common/testing/copier-contract/copier-ast.ts", // a comment naming the hand-off
    ]);
    const offenders = walk(SRC)
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .filter((rel) => !allowed.has(rel) && read(rel).includes("sourceLines"));
    expect(offenders).toEqual([]);
    expect(read("orders/dto/create-order.dto.ts")).not.toMatch(
      /sourceLine|packSnapshot|unitsPerBox/,
    );
  });

  it("approveNextDelivery fills the source line from the CHANGE_QTY line (price ALWAYS, pack only when box-aware) and create() consumes it", () => {
    const cr = read("orders/change-requests.service.ts");
    const keys = optionsPassedKeys(cr, "approveNextDelivery", "sourceLines");
    for (const k of [
      "unitsPerBox",
      "unitPrice",
      "priceType",
      "originalPrice",
      "overrideReason",
      "overriddenBy",
    ])
      expect(keys.has(k)).toBe(true);
    const method = cr.slice(cr.indexOf("private async approveNextDelivery("));
    expect(method).toContain("sourceItem = li");
    expect(method).toContain("sourceUpb = upb");
    const orders = read("orders/orders.service.ts");
    const createBody = orders.slice(orders.indexOf("  async create("));
    expect(createBody).toMatch(/sourceLineFor\(\s*item\.productId,\s*options\.sourceLines/);
    expect(createBody).toMatch(/\(\{ unitPrice, priceType, originalPrice \} = source\)/);
    expect(createBody).toMatch(/freeUnits = 0/);
  });

  it("an ADD_ITEM rollover has no source line (the filed split reconciles against the LIVE pack: a new sale)", () => {
    const cr = read("orders/change-requests.service.ts");
    const method = cr.slice(cr.indexOf("private async approveNextDelivery("));
    // sourceItem is only ever assigned in the CHANGE_QTY branch
    expect(method.match(/sourceItem = /g)).toHaveLength(1);
    expect(method.indexOf("sourceItem = li")).toBeGreaterThan(
      method.indexOf("ChangeRequestType.CHANGE_QTY"),
    );
  });
});
