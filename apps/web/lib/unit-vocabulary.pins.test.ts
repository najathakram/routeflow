/**
 * VU-1 (owner ruling R2, 2026-10-07): ONE unit vocabulary in operator copy. "Box" is the pack,
 * "pcs"/"piece" the loose item; a bigger level keeps its configured name. COPY ONLY — these pins
 * read source text. `UV_PINS_REF=<git-ref>` reads each file from that ref instead of the working
 * tree, which is how the RED counts against the pre-change tree are produced (no stash needed).
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

type Pin = { file: string; mustNotContain: string[]; mustContain: string[] };

const W = "apps/web/";
const D = `${W}app/(dashboard)/`;

const CHANGED: Pin[] = [
  {
    file: `${W}components/LineItemRow.tsx`,
    mustNotContain: [
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
    mustContain: [
      '"box" : "boxes"',
      '"pc" : "pcs"',
      '"Box price:"',
      'title="Total pieces"',
      'title="Number of whole boxes"',
      'title="Extra pieces (less than a full box)"',
      'aria-label="Extra pieces"',
      'aria-label="Remove extra pieces"',
      "+ pieces\n",
      "1 box = {li.unitsPerBox} pcs",
      '{li.qty === 1 ? "pc" : "pcs"} total',
    ],
  },
  {
    file: `${D}orders/_components/scan/PriceEditor.tsx`,
    mustNotContain: [
      '"Case" : "Unit"',
      'aria-label="Total ' + 'units"',
      'aria-label="Cases"',
      "Extra loose " + "units",
      "Remove extra " + "units",
      "+ units\n",
      "1 case = {li.unitsPerBox} units",
      '"Case price"',
    ],
    mustContain: [
      '"Box" : "Piece"',
      'aria-label="Total pieces"',
      'aria-label="Boxes"',
      'aria-label="Extra pieces"',
      'aria-label="Remove extra pieces"',
      "+ pieces\n",
      "1 box = {li.unitsPerBox} pcs",
      '"Box price"',
    ],
  },
  {
    file: `${D}invoices/new/page.tsx`,
    mustNotContain: [
      'title="Total ' + 'units"',
      'title="Cases"',
      ">c+<",
      'title="Extra loose ' + 'units"',
      "{item.qty} units",
    ],
    mustContain: [
      'title="Total pieces"',
      'title="Boxes"',
      ">box +<",
      'title="Extra pieces"',
      '{item.qty === 1 ? "pc" : "pcs"}',
      "pcs per box",
    ],
  },
  {
    file: `${D}orders/_components/add-line-merge.ts`,
    mustNotContain: ['boxLabel: "case"'],
    mustContain: ['boxLabel: "box"'],
  },
  {
    file: `${D}orders/[id]/scan-level-line.tsx`,
    mustNotContain: ['"case" : "cases"', "} loose`"],
    mustContain: ['"box" : "boxes"', '=== 1 ? "pc" : "pcs"'],
  },
  {
    file: `${W}components/VariantSplitModal.tsx`,
    mustNotContain: [
      "Number of whole " + "cases",
      "Extra loose " + "units",
      "less than a full case",
      ">cases</span>",
      ">units</span>",
      'unit${movedQty === 1 ? "" : "s"}',
    ],
    mustContain: [
      "Number of whole boxes",
      "Extra pieces (less than a full box)",
      ">boxes</span>",
      ">pcs</span>",
      '"pc" : "pcs"',
    ],
  },
  {
    file: `${W}components/family/FamilyVariantsGrid.tsx`,
    mustNotContain: ["Units / case", "units per case"],
    mustContain: ["Pieces per box", "pieces per box"],
  },
  {
    file: `${D}products/[id]/ProductUnitsCard.tsx`,
    mustNotContain: ["· the pack (edit", "derived from the pack price"],
    mustContain: ["· the box (edit", "derived from the box price"],
  },
  {
    file: `${D}inventory/_components/PurchaseOrdersCreateModal.tsx`,
    mustNotContain: [">Unit Cost ($)<", "Cost per unit", '"per unit"'],
    mustContain: [">Cost ($)<", "Cost per piece", '"per piece"'],
  },
  {
    file: `${D}inventory/_components/PurchaseOrderLinesTable.tsx`,
    mustNotContain: ["Unit Cost ($)", "Cost per unit", '"per unit"'],
    mustContain: ["  Cost ($)\n", "Cost per piece", '"per piece"'],
  },
  {
    file: `${D}returns/_components/InlineReturnSection.tsx`,
    mustNotContain: ['label="Qty (pieces)"'],
    mustContain: [],
  },
  // Tier B — setup surfaces
  {
    file: `${D}products/[id]/page.tsx`,
    mustNotContain: ['label="Units per case"'],
    mustContain: ['label="Pieces per box"'],
  },
  {
    file: `${D}products/page.tsx`,
    mustNotContain: ['header: "Units / case"'],
    mustContain: ['header: "Pieces per box"'],
  },
  {
    file: `${W}components/ProductCreateModal.tsx`,
    mustNotContain: ["Case code (SKU", ">Units per box<"],
    mustContain: ["Box code (SKU", ">Pieces per box<"],
  },
  {
    file: `${W}components/InlineCreateProductModal.tsx`,
    mustNotContain: [">Units per box<"],
    mustContain: [">Pieces per box<"],
  },
  {
    file: `${W}components/PackSizePrompt.tsx`,
    mustNotContain: ['aria-label="Units per box"'],
    mustContain: ['aria-label="Pieces per box"'],
  },
];

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
  { file: `${W}components/PriceHistory.tsx`, mustContain: ['"case"'] },
  {
    file: `${D}invoices/new/page.tsx`,
    mustContain: ['"case" | "unit"', 'aria-label="Unit price"'],
  },
  { file: `${W}components/LineItemRowReadOnly.tsx`, mustContain: ["formatQtySplit"] },
  { file: `${D}inventory/_components/PurchaseOrderReadOnlyLines.tsx`, mustContain: ["Unit Cost"] },
  {
    file: `${D}inventory/_components/PurchaseOrderLinesTable.tsx`,
    mustContain: ['aria-label="Unit cost"'],
  },
  { file: `${W}components/family/FamilyVariantsGrid.tsx`, mustContain: ['label: "Unit code"'] },
  { file: `${W}components/PackSizeUnknownModal.tsx`, mustContain: ["Units per case missing"] },
];

describe("VU-1 unit vocabulary: operator copy (web)", () => {
  describe.each(CHANGED)("$file", ({ file, mustNotContain, mustContain }) => {
    const src = read(file);
    it.each(mustNotContain)("no longer contains %j", (s) => {
      expect(src).not.toContain(s);
    });
    if (mustContain.length) {
      it.each(mustContain)("now contains %j", (s) => {
        expect(src).toContain(s);
      });
    }
  });

  describe.each(KEEP)("KEEP $file", ({ file, mustContain }) => {
    const src = read(file);
    it.each(mustContain)("still contains %j", (s) => {
      expect(src).toContain(s);
    });
  });
});
