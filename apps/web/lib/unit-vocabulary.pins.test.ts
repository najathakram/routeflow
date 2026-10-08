/**
 * U-3a (supersedes the VU-1 hard-coded pins): operator unit words come from ONE helper,
 * `unitWords()` in @routeflow/pricing, whose defaults print the VU-1 words exactly. COPY ONLY — these
 * pins read source text. `UV_PINS_REF=<git-ref>` reads each file from that ref instead of the working
 * tree (that is how the RED counts against the pre-change tree are produced; no stash needed).
 *
 *  1. OLD literals (pre-VU-1 "case/unit" words) are gone.
 *  2. Every listed file imports the helper from @routeflow/pricing.
 *  3. No hard-coded Box/Piece/box/pcs display literal is left in a listed file (comments stripped;
 *     the few legitimate non-display strings are allow-listed below with the reason).
 *  4. KEEP: behaviour/identity literals the copy change must never touch (VU-1 §9.2).
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "../../..");
const REF = process.env.UV_PINS_REF;

function read(file: string): string {
  if (REF) return execFileSync("git", ["show", `${REF}:${file}`], { cwd: ROOT }).toString();
  return readFileSync(resolve(ROOT, file), "utf8");
}

const W = "apps/web/";
const D = `${W}app/(dashboard)/`;

/** Source with block and line comments removed. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{(,])\/\/[^\n]*/g, "$1");
}

const WORD = /\b(box|boxes|piece|pieces|pc|pcs)\b/i;

/** Every string literal, template literal and JSX text run in the source that holds a unit word. */
function displayLiterals(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  const add = (s: string) => WORD.test(s) && out.push(s.trim());
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) add(m[1]);
  for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) add(m[1]);
  // Template literals: only the literal text between substitutions counts.
  for (const m of code.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
    for (const part of m[1].split(/\$\{[^}]*\}/)) add(part);
  }
  // JSX text runs, including runs that hold `{…}` expressions: scan the literal segments between
  // the tags and the braces ("{n} per box" must be caught). `=>` arrows are not tag closers.
  for (const m of code.matchAll(/(?<!=)>([^<>]*)</g)) {
    const text = m[1].replace(/\{[^{}]*\}/g, "\u0000").replace(/\{[^{}]*\}/g, "\u0000");
    for (const part of text.split("\u0000")) if (!/[=;]/.test(part)) add(part);
  }
  return out;
}

type Pin = {
  file: string;
  /** Old (pre-VU-1) literals that must be gone. */
  gone: string[];
  /** Exact string-literal contents that are legitimately NOT display words (with the reason). */
  allow?: string[];
};

const FILES: Pin[] = [
  {
    file: `${D}inventory/_components/PurchaseOrderReadOnlyLines.tsx`,
    gone: [">Unit Cost<"],
  },
  {
    file: `${W}components/LineItemRow.tsx`,
    gone: [
      '"case" : "cases"',
      '"unit" : "units"',
      '"Case price:"',
      'title="Total ' + 'units"',
      'title="Number of whole ' + 'cases"',
      "Extra loose " + "units",
      "Remove extra " + "units",
      "+ units\n",
      "1 case = {li.unitsPerBox} units",
    ],
  },
  {
    file: `${D}orders/_components/scan/PriceEditor.tsx`,
    gone: [
      '"Case" : "Unit"',
      'aria-label="Total ' + 'units"',
      'aria-label="Cases"',
      "Extra loose " + "units",
      "Remove extra " + "units",
      "+ units\n",
      "1 case = {li.unitsPerBox} units",
      '"Case price"',
    ],
  },
  {
    file: `${D}invoices/new/page.tsx`,
    gone: ['title="Total ' + 'units"', 'title="Cases"', ">c+<", "{item.qty} units"],
  },
  {
    file: `${D}orders/_components/add-line-merge.ts`,
    gone: ['boxLabel: "case"'],
  },
  {
    file: `${D}orders/[id]/scan-level-line.tsx`,
    gone: ['"case" : "cases"', "} loose`"],
    allow: ["BOX"], // the SellLevel code compared against, never shown
  },
  {
    file: `${W}components/VariantSplitModal.tsx`,
    gone: [
      "Number of whole " + "cases",
      "Extra loose " + "units",
      "less than a full case",
      ">cases</span>",
      ">units</span>",
      'unit${movedQty === 1 ? "" : "s"}',
    ],
  },
  {
    file: `${W}components/family/FamilyVariantsGrid.tsx`,
    gone: ["Units / case", "units per case"],
  },
  {
    file: `${D}products/[id]/ProductUnitsCard.tsx`,
    gone: ["· the pack (edit", "derived from the pack price"],
  },
  {
    file: `${D}inventory/_components/PurchaseOrdersCreateModal.tsx`,
    gone: [">Unit Cost ($)<", "Cost per unit", '"per unit"'],
    allow: ["boxes", "pieces"], // line-state field keys passed to updateLine, never shown
  },
  {
    file: `${D}inventory/_components/PurchaseOrderLinesTable.tsx`,
    gone: ["Unit Cost ($)", "Cost per unit", '"per unit"'],
  },
  {
    file: `${D}returns/_components/InlineReturnSection.tsx`,
    gone: ['label="Qty (pieces)"'],
  },
  { file: `${D}products/[id]/page.tsx`, gone: ['label="Units per case"'] },
  { file: `${D}products/page.tsx`, gone: ['header: "Units / case"'] },
  {
    file: `${W}components/ProductCreateModal.tsx`,
    gone: ["Case code (SKU", ">Units per box<"],
  },
  { file: `${W}components/InlineCreateProductModal.tsx`, gone: [">Units per box<"] },
  { file: `${W}components/PackSizePrompt.tsx`, gone: ['aria-label="Units per box"'] },
];

describe("U-3a unit words: operator copy comes from the helper (web)", () => {
  describe.each(FILES)("$file", ({ file, gone, allow = [] }) => {
    const src = read(file);
    it.each(gone)("no longer contains %j", (s) => {
      expect(src).not.toContain(s);
    });
    it("imports unitWords from @routeflow/pricing", () => {
      expect(src).toMatch(/import\s*\{[^}]*\bunitWords\b[^}]*\}\s*from\s*"@routeflow\/pricing"/);
    });
    it("has no hard-coded Box/Piece/box/pcs display literal", () => {
      const left = displayLiterals(src).filter((s) => !allow.includes(s));
      expect(left).toEqual([]);
    });
  });
});

// KEEP: behaviour/identity literals the copy change must never touch (green before AND after).
const KEEP: Array<{ file: string; mustContain: string[] }> = [
  {
    file: `${W}components/LineItemRow.tsx`,
    mustContain: [
      'sellBy?: "case" | "unit"',
      'onSetSellBy("case")',
      'onSetSellBy("unit")',
      '"case" : li.unit)',
      'data-testid="line-qty-cases-row"',
      'aria-label="Quantity"',
    ],
  },
  {
    file: `${D}orders/_components/scan/PriceEditor.tsx`,
    mustContain: ['(["case", "unit"] as const)'],
  },
  { file: `${D}orders/[id]/page.tsx`, mustContain: ['"case"'] },
  {
    file: `${W}components/PriceHistory.tsx`,
    mustContain: ['"case"', 'v === "box" || v === "cases" || v === "boxes" ? "case" : v'],
  },
  {
    file: `${D}products/[id]/ProductUnitsCard.tsx`,
    mustContain: ['placeholder="e.g. Case"', "Add a Case or Pallet"],
  },
  { file: `${D}products/[id]/page.tsx`, mustContain: ['label="Case unit of measure"'] },
  { file: `${W}components/ProductCreateModal.tsx`, mustContain: ["Case unit of measure"] },
  {
    file: `${D}invoices/new/page.tsx`,
    mustContain: ['"case" | "unit"', 'aria-label="Unit price"'],
  },
  { file: `${W}components/LineItemRowReadOnly.tsx`, mustContain: ["formatQtySplit"] },
  {
    file: `${D}inventory/_components/PurchaseOrderLinesTable.tsx`,
    mustContain: ['aria-label="Unit cost"'],
  },
  { file: `${W}components/family/FamilyVariantsGrid.tsx`, mustContain: ['label: "Unit code"'] },
  { file: `${W}components/PackSizeUnknownModal.tsx`, mustContain: ["Units per case missing"] },
];

describe("U-3a KEEP: behaviour and identity literals", () => {
  describe.each(KEEP)("KEEP $file", ({ file, mustContain }) => {
    const src = read(file);
    it.each(mustContain)("still contains %j", (s) => {
      expect(src).toContain(s);
    });
  });
});
