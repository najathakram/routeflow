/**
 * SA-1042 B9b structural pins: one grouping for the preview and the mint, and the wire's `line`.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { lineOfItem, withLines } from "./return-line-items";

const src = readFileSync(join(__dirname, "returns.service.ts"), "utf8");
const body = (name: string) => {
  const start = src.indexOf(
    `  private ${name === "priceReturn" ? "priceReturn" : "async itemiseRefund"}(`,
  );
  expect(start).toBeGreaterThan(0);
  return src.slice(start, start + 7000);
};

describe("one grouping (rule 7)", () => {
  it("priceReturn and itemiseRefund both group through groupReturnItems (no second grouping)", () => {
    expect(body("priceReturn")).toContain("groupReturnItems(");
    expect(body("itemiseRefund")).toContain("groupReturnItems(");
  });
  it("neither groups by productId alone any more", () => {
    expect(body("priceReturn")).not.toMatch(/billedItemsByProduct|returned\.set\(item\.productId/);
    expect(body("itemiseRefund")).not.toContain("returnedByProduct");
  });
});

describe("the wire's `line` (rule 8)", () => {
  const order = {
    lineItems: [
      { id: "A", productId: "P", qty: 400, boxes: 2, unitsPerBox: 200, unitLabel: "Case" },
    ],
  };
  it("carries a loose line's pieces, which the pieces-only count reads", () => {
    const loose = {
      lineItems: [{ id: "L", productId: "P", qty: 5, boxes: null, pieces: 5, unitsPerBox: 10 }],
    };
    expect(lineOfItem({ sourceOrderItemId: "L" }, loose as any)).toEqual({
      unitLabel: null,
      unitsPerBox: 10,
      boxes: null,
      pieces: 5,
      qty: 5,
    });
  });

  it("names the item's order line from its snapshot, null when pooled or unknown", () => {
    expect(lineOfItem({ sourceOrderItemId: "A" }, order as any)).toEqual({
      unitLabel: "Case",
      unitsPerBox: 200,
      boxes: 2,
      pieces: null,
      qty: 400,
    });
    expect(lineOfItem({ sourceOrderItemId: null }, order as any)).toBeNull();
    expect(lineOfItem({ sourceOrderItemId: "zzz" }, order as any)).toBeNull();
    expect(
      withLines([{ sourceOrderItemId: "A" }, {}], order as any).map(
        (i) => i.line?.unitLabel ?? null,
      ),
    ).toEqual(["Case", null]);
  });
});

describe("the line key is the resolver's (A-2 F2)", () => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  it("a stored return row's sourceOrderItemId is never read from the DTO's orderItemId", () => {
    expect(code).not.toMatch(/sourceOrderItemId:\s*i\.orderItemId/);
    expect([...code.matchAll(/sourceOrderItemId: i\.sourceOrderItemId/g)]).toHaveLength(1);
    expect(code).toMatch(/sourceOrderItemId: r\.orderItemId/);
  });
});
