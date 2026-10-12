import { readFileSync } from "fs";
import { join } from "path";

/**
 * F5: a Settings save refused by a READ_ONLY workspace is already answered by the app-wide handler (the shared
 * read-only line). A page-local `onError` must not add its own generic "Failed to save ..." on top of it, so every
 * `onError` in the Settings page asks `isReadOnlyRefusal` first (by predicate, so a NEW save cannot skip it).
 */
const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("Settings page: a READ_ONLY refusal is never answered with a generic save error", () => {
  it("every onError handler checks isReadOnlyRefusal first", () => {
    const offenders: number[] = [];
    let count = 0;
    const re = /onError:\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      count += 1;
      const head = src.slice(m.index, m.index + 240);
      if (!/isReadOnlyRefusal\(/.test(head))
        offenders.push(src.slice(0, m.index).split("\n").length);
    }
    expect(count).toBeGreaterThanOrEqual(10); // the scan is not vacuous
    expect(offenders).toEqual([]);
  });
});
