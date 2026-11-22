import * as fs from "fs";
import * as path from "path";

/**
 * SA-1214 (D7'): on the buyer route `availableCredit` is already notes PLUS advances and `advanceBalance` is the advance
 * PART of that total. A buyer screen that reads `advanceBalance` and adds it counts the advances twice ($500 + $200).
 * This reads every customer (buyer) screen and the buyer API file and fails if one touches it.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const ROOT = path.resolve(__dirname, "..");
const SOURCES = [
  ...walk(path.join(ROOT, "app", "(customer)")),
  path.join(ROOT, "lib", "api", "buyer.ts"),
];

describe("buyer screens never read advanceBalance (SA-1214)", () => {
  it("scans the customer screens (the pin is not vacuous)", () => {
    expect(SOURCES.length).toBeGreaterThan(5);
  });

  it("no customer screen or buyer API file reads advanceBalance", () => {
    const offenders = SOURCES.filter((f) => /advanceBalance/.test(fs.readFileSync(f, "utf8"))).map(
      (f) => path.relative(ROOT, f),
    );
    expect(offenders).toEqual([]);
  });
});
