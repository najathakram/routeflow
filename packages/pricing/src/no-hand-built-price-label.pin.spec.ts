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

// PR-B: a price quoted "per {x.unit}" / "/ {x.unit}" by hand reads "per can" over a box price.
const HAND_BUILT_PER = [
  /\bper\s+\{\s*[\w.?]*\bunit\s*\}/,
  /\bper\s+\$\{\s*[\w.?]*\bunit\s*\}/,
  /\/\s+\$\{\s*[\w.?]*\bunit\s*\}/,
  /\/\s+\{\s*[\w.?]*\bunit\s*\}/,
  // the pack-count tail the buyer tiles hand-built: " (${n}/box)" or "({n}/box)"
  /\(\s*\$?\{[^}]*\}\s*\/\s*box\s*\)/,
];

// Files that keep a hand-written "/ {unit}" on purpose, each with its reason (PR-B scan decisions).
const ALLOW_PER = [
  // boxed lines print "/ box" first; the unit fallback is reached only for a line with no pack
  [path.join("(customer)", "orders", "cart.tsx"), "B1398: boxed branch first; fallback is unboxed"],
  [path.join("edit-items", "ProductPicker.tsx"), "B1398: boxed branch first; fallback is unboxed"],
  ["invoice-line-display.ts", "B1398: pack lines (upb > 1) return first; fallback is factor-1"],
  // staff order editors that carry their own pack-aware price unit; converting needs a behaviour change
  [path.join("scan", "PriceEditor.tsx"), "B1398: staff scan editor, own priceUnit logic"],
  ["LineItemRow.tsx", "B1398: staff unlisted-line price input"],
  // mobile rows with a separate boxed branch ("case of N" / "box") ahead of the unit fallback; the hardcoded
  // pack word that ignores the tenant's pack name is B1398
  ["CartRow.tsx", "B1398: boxed branch first; fallback is unboxed"],
  ["ProductRow.tsx", "B1398: boxed branch first; fallback is unboxed"],
  [path.join("invoices", "new.tsx"), "B1398: boxed branch first; fallback is unboxed"],
  // not a product price label
  [
    path.join("_components", "CounterLinePriceEdit.tsx"),
    "B1398: not a price row, the editor's item label",
  ],
  [path.join("price-history", "PriceHistoryChart.tsx"), "B1398: not a price row, a chart caption"],
  // need a behaviour change, each with its own bug: not converted here
  [path.join("(customer)", "invoices", "[id].tsx"), "B1402: pieces printed before the box price"],
  [path.join("(customer)", "orders", "[id].tsx"), "B1401: needs a behaviour change"],
  [path.join("[id]", "edit-items.tsx"), "B1395: that bug rewrites this file through the helper"],
] as const;

// shrink-only (OP-7): lower this when an entry goes, never raise it
const ALLOW_PER_MAX = 13;

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, " ");
}

export function handBuilt(src: string): boolean {
  return HAND_BUILT.some((re) => re.test(strip(src)));
}

export function handBuiltPer(src: string): boolean {
  return HAND_BUILT_PER.some((re) => re.test(strip(src)));
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

  it.each([
    ["JSX per", "<p>per {item.unit}</p>"],
    ["template per", "`per ${p.unit}`"],
    ["template slash", "` / ${p.unit}`"],
    ["JSX slash", "<span>/ {li.unit}</span>"],
    ["bare name", "<p>per {unit}</p>"],
    ["a count tail, template", "` (${product.unitsPerBox}/box)`"],
    ["a count tail, JSX", "<p>per case ({n}/box)</p>"],
  ])("the per-unit detector sees %s", (_n, src) => {
    expect(handBuiltPer(src)).toBe(true);
  });

  it("the per-unit detector ignores the helper, a URL path and a comment", () => {
    expect(handBuiltPer("{pricedPerLabel({ unit: p.unit }).perText}")).toBe(false);
    expect(handBuiltPer("`/api/${unit}`")).toBe(false);
    expect(handBuiltPer("// per {x.unit} is wrong")).toBe(false);
  });

  it("no web or mobile source words a per-unit price by hand (allowlist is reasoned)", () => {
    const hits = ROOTS.flatMap((r) => collect(r))
      .filter((f) => !ALLOW_PER.some(([a]) => f.endsWith(a)))
      .filter((f) => handBuiltPer(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO_ROOT, f));
    expect(hits).toEqual([]);
  });

  it("the allowlist is count-pinned (shrink-only) and every reason names a bug id", () => {
    expect(ALLOW_PER.length).toBeLessThanOrEqual(ALLOW_PER_MAX);
    for (const [, reason] of ALLOW_PER) expect(reason).toMatch(/^B\d{3,4}:/);
  });

  it("every allowlisted file still needs its entry", () => {
    const files = ROOTS.flatMap((r) => collect(r));
    for (const [a] of ALLOW_PER) {
      const f = files.find((x) => x.endsWith(a));
      expect(f).toBeDefined();
      expect(handBuiltPer(fs.readFileSync(f!, "utf8"))).toBe(true);
    }
  });

  it("no web or mobile source builds a price label by hand", () => {
    const hits = ROOTS.flatMap((r) => collect(r))
      .filter((f) => !ALLOW.some((a) => f.endsWith(a)))
      .filter((f) => handBuilt(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO_ROOT, f));
    expect(hits).toEqual([]);
  });
});
