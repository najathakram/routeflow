import * as fs from "fs";
import * as path from "path";

/**
 * SA-1214 (D7'): on the buyer route `availableCredit` is already notes PLUS advances and `advanceBalance` is the advance
 * PART of that total. A buyer screen that reads `advanceBalance` and adds it (or shows it beside the tile) counts the
 * advances twice ($500 + $200). This reads every buyer screen and buyer API source and fails if one touches it.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const WEB = path.resolve(__dirname, "../../../..");
const SOURCES = [
  ...walk(path.join(WEB, "app", "buyer")),
  ...walk(path.join(WEB, "components", "account-statement")),
  path.join(WEB, "lib", "api", "buyer.ts"),
];

describe("buyer screens never read advanceBalance (SA-1214)", () => {
  it("scans the buyer screens (the pin is not vacuous)", () => {
    expect(SOURCES.length).toBeGreaterThan(10);
  });

  it("no buyer screen or buyer API file reads advanceBalance", () => {
    const offenders = SOURCES.filter((f) => /advanceBalance/.test(fs.readFileSync(f, "utf8"))).map(
      (f) => path.relative(WEB, f),
    );
    expect(offenders).toEqual([]);
  });
});
