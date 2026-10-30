import * as fs from "fs";
import * as path from "path";

/**
 * Row 750 (class fold): the New sale / Other charge page never takes "today" from the BROWSER's clock. The delivery date,
 * the issue date, the due date, the backdate check and the picker's max all use `useTenantToday()` (the business's day,
 * empty while the zone loads). This pin fails on ANY remaining browser-day idiom in the page: a local `todayIso`, a
 * `new Date().toISOString()` slice, or `setHours(0, 0, 0, 0)`.
 */
const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
const IDIOMS: Array<[string, RegExp]> = [
  ["a local todayIso", /\btodayIso\b/],
  ["new Date().toISOString() as a day", /new Date\(\)\.toISOString\(\)/],
  ["new Date().toDateString()", /new Date\(\)\.toDateString\(\)/],
  ["setHours(0, 0, 0, 0)", /setHours\(0,\s*0,\s*0,\s*0\)/],
];

describe("invoices/new page: no browser-clock 'today'", () => {
  it.each(IDIOMS)("has no %s", (_name, re) => {
    const lines = src
      .split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => re.test(l) && !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .map(([n, l]) => `${n}: ${l.trim()}`);
    expect(lines).toEqual([]);
  });

  it("positive control: the matcher sees each idiom", () => {
    expect(
      IDIOMS.every(([, re]) =>
        re.test(
          "todayIso() new Date().toISOString() new Date().toDateString() d.setHours(0, 0, 0, 0)",
        ),
      ),
    ).toBe(true);
  });
});
