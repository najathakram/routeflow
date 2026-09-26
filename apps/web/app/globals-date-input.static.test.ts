import * as fs from "fs";
import * as path from "path";

// #2080: globals.css's date/time-input rule. A positive min-width there overrides a narrower
// `w-*` (width is not min-width) and overflows every date input in a narrow grid track; the
// iOS fix needs both the prefixed and unprefixed `appearance` (no autoprefixer runs here).
const css = fs.readFileSync(path.join(__dirname, "globals.css"), "utf8");
const DATE_TYPES = /input\[type="(date|time|datetime-local|month|week)"\]/;
const rules = Array.from(css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g))
  .filter(([, selector]) => DATE_TYPES.test(selector))
  .map(([, selector, body]) => ({ selector: selector.trim(), body }));

describe("globals.css date/time-input rule (#2080)", () => {
  it("exists", () => {
    expect(rules.length).toBeGreaterThan(0);
  });

  it("never sets a positive min-width on a date/time input", () => {
    const positive = rules.filter((r) =>
      Array.from(r.body.matchAll(/min-width\s*:\s*([^;]+)/g)).some(
        ([, v]) => !/^0(px)?$/.test(v.trim()),
      ),
    );
    expect(positive.map((r) => r.selector)).toEqual([]);
  });

  it("switches off the native appearance with both the prefixed and unprefixed property", () => {
    const main = rules.find((r) => !r.selector.includes("::"));
    expect(main?.body).toMatch(/(^|[\s;])-webkit-appearance\s*:\s*none/);
    expect(main?.body).toMatch(/(^|[\s;])appearance\s*:\s*none/);
    expect(main?.body).toMatch(/box-sizing\s*:\s*border-box/);
  });
});
