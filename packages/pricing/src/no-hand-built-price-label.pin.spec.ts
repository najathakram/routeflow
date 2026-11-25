/**
 * B1383 (SA-1281 part 2) structural pin: a product price label is built in ONE place, `pricedPerLabel`.
 * A hand-built "Price per ${unit}" is how a box price came to read "per can". This scans the web and mobile
 * sources (spec/test files excluded) for a price label assembled by hand; the count is zero and may only stay zero.
 */
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const ROOTS = ["apps/web", "apps/mobile"].map((p) => path.join(REPO_ROOT, p));

const ALLOW = [
  // the order-line price editor words its own "item" label (SA-1067), not a product price row
  path.join("orders", "_components", "CounterLinePriceEdit.tsx"),
];

const HAND_BUILT = [
  // a credit label that already names the pack word (`Credit price per ${UW.pack.lower}`) is correct
  /Price per\s*\$\{(?!\s*UW\.pack)/i,
  /["'`]Price per ["'`]\s*\+/i,
  /["'`]Price per unit["'`]/i,
  // JSX text: <Text>Price per {u}</Text>; the optional piece-price field names the base word and stays legitimate
  /Price per\s*\{(?!\s*w\.base\.)/i,
];

export function handBuilt(src: string): boolean {
  return HAND_BUILT.some((re) => re.test(src.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, " ")));
}

function collect(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "dist", "coverage", ".expo", "e2e"].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collect(full, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(spec|test)\.[tj]sx?$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("no hand-built price label outside pricedPerLabel (B1383)", () => {
  it.each([
    ["a template", "const l = `Price per ${unitWord} *`;"],
    ["a template, spaced", "`Price per   ${u}`"],
    ["a concatenation", 'const l = "Price per " + unit;'],
    ["JSX text", "<Text>Price per {u}</Text>"],
    ["lower case", "const l = `price per ${u}`;"],
    ["the mobile literal", '<FormField label="Price per unit">'],
  ])("the detector sees %s", (_n, src) => {
    expect(handBuilt(src)).toBe(true);
  });

  it("does not trip on a comment, the helper's own call or the optional piece-price label", () => {
    expect(handBuilt("// Price per ${x} is wrong")).toBe(false);
    expect(handBuilt("label={pricedPerLabel({ unit }).label}")).toBe(false);
    expect(handBuilt('Price per {w.base.lower}{" "}')).toBe(false);
  });

  it("no web or mobile source builds a price label by hand", () => {
    const hits = ROOTS.flatMap((r) => collect(r))
      .filter((f) => !ALLOW.some((a) => f.endsWith(a)))
      .filter((f) => handBuilt(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO_ROOT, f));
    expect(hits).toEqual([]);
  });
});
