import { readFileSync } from "fs";
import { join } from "path";

/**
 * F5: a Settings save refused by a READ_ONLY workspace is already answered by the app-wide handler (the shared
 * read-only line). A page-local `onError` must not add its own generic "Failed to save ..." on top of it, so every
 * `onError` in the Settings page asks `isReadOnlyRefusal` first (by predicate, so a NEW save cannot skip it).
 */
const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("Settings page: a READ_ONLY refusal is never answered with a generic save error", () => {
  it("every onError handler checks isReadOnlyRefusal (after any state cleanup, before the toast)", () => {
    const offenders: number[] = [];
    let count = 0;
    const re = /onError:\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      count += 1;
      const head = src.slice(m.index, m.index + 420);
      if (!/isReadOnlyRefusal\(/.test(head))
        offenders.push(src.slice(0, m.index).split("\n").length);
    }
    expect(count).toBeGreaterThanOrEqual(10); // the scan is not vacuous
    expect(offenders).toEqual([]);
  });

  it("a READ_ONLY refusal still runs the handler's state cleanup: no setter follows the early return", () => {
    // the early return may only guard the toast (a refused logo must still drop its preview, a refused deposit
    // must still restore the saved value)
    const offenders: number[] = [];
    const re = /if \(isReadOnlyRefusal\(\w+\)\) return;[^\n]*\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 500);
      const body = rest.split(/\n\s*\},?\n/)[0]; // up to the handler's closing brace
      if (/\bset(?!Error\b)[A-Z]\w*\(/.test(body))
        offenders.push(src.slice(0, m.index).split("\n").length);
    }
    expect(offenders).toEqual([]);
  });
});
