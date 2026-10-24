import * as fs from "fs";
import * as path from "path";
import { Prisma } from "@prisma/client";
import {
  absoluteCountChanged,
  COUNT_QTY_DECIMAL_PLACES,
  roundCountQty,
} from "./stock-count-commit";

describe("roundCountQty (SA-767 r-note 5 MF3)", () => {
  it("rounds to the Decimal(10,3) column, half up, whatever the float's tail", () => {
    expect(COUNT_QTY_DECIMAL_PLACES).toBe(3);
    expect(roundCountQty(0.1 + 0.1 + 0.1).toString()).toBe("0.3");
    expect(roundCountQty(1.2345).toString()).toBe("1.235");
    expect(roundCountQty(1.2344).toString()).toBe("1.234");
    expect(roundCountQty(new Prisma.Decimal("100.0004")).toString()).toBe("100");
    expect(roundCountQty("2.0005").toString()).toBe("2.001");
  });

  it("makes a client float equal to what the column stores", () => {
    expect(
      absoluteCountChanged(
        { countedQty: new Prisma.Decimal("0.300"), boxes: null, pieces: null },
        { countedQty: roundCountQty(0.1 + 0.1 + 0.1), boxes: null, pieces: null },
      ),
    ).toBe(false);
    expect(
      absoluteCountChanged(
        { countedQty: new Prisma.Decimal("0.300"), boxes: null, pieces: null },
        { countedQty: roundCountQty(0.301), boxes: null, pieces: null },
      ),
    ).toBe(true);
  });
});

describe("roundCountQty is the ONE place a count quantity is rounded (lead refinement of MF3)", () => {
  it("prints at the column's scale and rounds negatives symmetrically (half away from zero)", () => {
    expect(roundCountQty(0.1 + 0.1 + 0.1).toFixed(3)).toBe("0.300");
    expect(roundCountQty(-1.2345).toString()).toBe("-1.235");
    expect(roundCountQty(-0.30000000000000004).toFixed(3)).toBe("-0.300");
    expect(roundCountQty(-2.0005).toString()).toBe("-2.001");
  });

  it("absoluteCountChanged rounds BOTH sides itself: a raw float tail is not a change", () => {
    expect(
      absoluteCountChanged(
        { countedQty: new Prisma.Decimal("0.300") },
        { countedQty: new Prisma.Decimal(0.30000000000000004) },
      ),
    ).toBe(false);
    expect(
      absoluteCountChanged(
        { countedQty: new Prisma.Decimal("1.235") },
        { countedQty: new Prisma.Decimal(1.2345) },
      ),
    ).toBe(false);
    expect(
      absoluteCountChanged(
        { countedQty: new Prisma.Decimal("0.300") },
        { countedQty: new Prisma.Decimal("0.301") },
      ),
    ).toBe(true);
  });

  it("structural pin: no other toDecimalPlaces( in the count code - only the helper rounds", () => {
    const dir = __dirname;
    const count = fs.readFileSync(path.join(dir, "stock-count-commit.ts"), "utf8");
    expect(count.match(/toDecimalPlaces\(/g) ?? []).toHaveLength(1);
    expect(count).toMatch(/toDecimalPlaces\(\s*COUNT_QTY_DECIMAL_PLACES,/);
    const service = fs.readFileSync(path.join(dir, "inventory.service.ts"), "utf8");
    expect(service).not.toMatch(/toDecimalPlaces\(/);
    expect(service).toMatch(/roundCountQty\(/);
  });
});
