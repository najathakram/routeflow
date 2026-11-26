import { readFileSync } from "fs";
import { join } from "path";
import { evidenceOrigin } from "../invoices/delivered-basis-by-line";

/**
 * SA-1506 A2 NEW-M1 / SA-1514 LOW 3: `evidenceOrigin` is the ONE test of who wrote an evidence row (a stop or a driver =
 * "route", everything else = "office"). Structure pin over the CLASSIFICATION sites only (readers that merely select the
 * columns are outside it): each must call `evidenceOrigin` and none may re-test the two columns on a row of its own.
 */
const SITES = [
  "orders/route-held-lines.ts",
  "orders/office-evidence-completion.ts",
  "orders/delivered-line-facts.ts",
];
const src = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("evidence-origin pin (one classifier)", () => {
  it.each(SITES)("%s calls evidenceOrigin", (rel) => {
    expect(stripComments(src(rel))).toMatch(/evidenceOrigin\(/);
  });

  it.each(SITES)("%s never re-tests routeRunStopId / driverId on a row itself", (rel) => {
    const code = stripComments(src(rel));
    const own = code
      .split("\n")
      .filter((l) => /\b(m|row|r|mut)\.(routeRunStopId|driverId)\b/.test(l));
    expect(own).toEqual([]);
  });

  it("classifies: a stop or a driver is route, nothing else is", () => {
    const base = { type: "DELIVERED", quantityDelivered: 1 };
    expect(evidenceOrigin({ ...base, routeRunStopId: "s1" })).toBe("route");
    expect(evidenceOrigin({ ...base, driverId: "d1" })).toBe("route");
    expect(evidenceOrigin({ ...base, routeRunStopId: null, driverId: null })).toBe("office");
    expect(evidenceOrigin({ ...base })).toBe("office");
  });

  it("the correction writer's office-row where-clause is the same two columns (the DB twin of 'office')", () => {
    const code = stripComments(src("orders/delivered-line-correction.ts"));
    const twins = code.match(/routeRunStopId: null, driverId: null/g) ?? [];
    expect(twins.length).toBeGreaterThanOrEqual(1); // restateOfficeRows (office-only); officeRowSum folds the one read through evidenceOrigin
    expect(code).toContain('evidenceOrigin(m) === "office"');
  });
});
