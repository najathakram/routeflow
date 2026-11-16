import { readFileSync } from "node:fs";
import path from "node:path";
import { ORDER_DATE_COPY } from "./order-date-copy";

const DIR = path.join(__dirname, "..", "app", "(dashboard)", "orders", "_components");
const codeOf = (file: string) =>
  readFileSync(path.join(DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** W-1188: the chip and its picker name the date through ORDER_DATE_COPY only, so the New sale invoice can say "Sale date". */
describe("the date chip and picker spell their noun through the copy map only", () => {
  it.each(["CounterDateChip.tsx", "CounterDatePicker.tsx"])(
    "%s has no hard-coded 'order date' or 'sale date' string",
    (file) => {
      const code = codeOf(file);
      expect(code).not.toMatch(/order date/i);
      expect(code).not.toMatch(/sale date/i);
      expect(code).toContain("ORDER_DATE_COPY");
    },
  );

  // B1318: the noun regex above misses a sentence with no noun in it (the till's "outside the dates this till takes" put back
  // in the picker). Every whole string the map owns, for every noun, must be absent from the chip and picker source.
  it.each(["CounterDateChip.tsx", "CounterDatePicker.tsx"])(
    "%s repeats no whole string the copy map owns",
    (file) => {
      const code = codeOf(file);
      const owned = Object.values(ORDER_DATE_COPY).flatMap((c) =>
        Object.values(c).filter((v): v is string => typeof v === "string"),
      );
      expect(owned.length).toBeGreaterThan(0);
      for (const text of owned) expect(code).not.toContain(text);
      expect(code).not.toMatch(/outside the dates/i);
    },
  );

  it("every noun has the same keys and whole strings (no glued sentences)", () => {
    const keys = Object.keys(ORDER_DATE_COPY.order).sort();
    expect(Object.keys(ORDER_DATE_COPY.sale).sort()).toEqual(keys);
    for (const noun of ["order", "sale"] as const) {
      const c = ORDER_DATE_COPY[noun];
      const word = noun === "order" ? "Order" : "Sale";
      expect(c.label).toBe(`${word} date`);
      expect(c.dialogTitle).toBe(c.label);
      expect(c.todayName).toBe(`${word} date: today. Change`);
      expect(c.clearName).toBe(`Clear the ${noun} date, back to today`);
      expect(c.unknownName("Wed, Nov 11", false)).toContain(`${word} date Wed, Nov 11`);
    }
  });
});
