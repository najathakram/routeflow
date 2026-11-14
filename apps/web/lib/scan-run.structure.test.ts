import * as fs from "fs";
import * as path from "path";

/**
 * SA-1138 S4: ONE run-start rule. The sites that decide where a scan's first key goes import `@/lib/scan-run`; none spells the
 * old shapes again, and the module reads no clock.
 */
const WEB = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");

const SITES = [
  "app/(dashboard)/orders/_components/CounterSaleScreen.tsx",
  "app/(dashboard)/orders/_components/CounterDatePicker.tsx",
  "app/(dashboard)/orders/_components/CreateOrderModal.tsx",
  "components/SortableLines.tsx",
];
const OLD_SHAPES: Array<[string, RegExp]> = [
  ["digit/capital regex", /\^\[0-9A-Z\]\$\//],
  ["digit/letter regex", /\^\[0-9A-Za-z\]\$\//],
  ["non-space regex", /\/\^\\S\$\//],
  ["printable test", /e\.key\.length !== 1 \|\| e\.key === " "/],
  ["isPrintable", /const isPrintable/],
];
const CLOCK = /Date\.now|performance\.now|setTimeout|timeStamp|\.repeat/;

describe("scan-run structure pin (SA-1138 S4)", () => {
  it("the module reads no clock", () => {
    const src = read("lib/scan-run.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(CLOCK);
  });
  it("every run-start site imports the module and none keeps an old spelling", () => {
    let filesRead = 0;
    for (const rel of SITES) {
      const src = read(rel);
      filesRead++;
      expect({ rel, imports: /from "@\/lib\/scan-run"/.test(src) }).toEqual({ rel, imports: true });
      for (const [name, re] of OLD_SHAPES) {
        expect({ rel, name, found: re.test(src) }).toEqual({ rel, name, found: false });
      }
    }
    expect(filesRead).toBe(4);
  });
});
