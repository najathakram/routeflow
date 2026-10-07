/**
 * VU-1 (owner ruling R2, 2026-10-07): ONE unit vocabulary in operator copy. "Box" is the pack,
 * "pcs"/"piece" the loose item. COPY ONLY — these pins read source text. `UV_PINS_REF=<git-ref>`
 * reads each file from that ref instead of the working tree, which is how the RED counts against
 * the pre-change tree are produced (no stash needed).
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const APP = join(__dirname, "..");
const ROOT = resolve(APP, "../..");
const REF = process.env.UV_PINS_REF;

function read(rel: string): string {
  if (REF)
    return execFileSync("git", ["show", `${REF}:apps/mobile/${rel}`], { cwd: ROOT }).toString();
  return readFileSync(join(APP, rel), "utf8");
}

type Pin = { file: string; mustNotContain: string[]; mustContain: string[] };

const INV = "app/(operator)/(tabs)/invoices";

const CHANGED: Pin[] = [
  {
    file: `${INV}/new.tsx`,
    mustNotContain: [
      'label="Cases"',
      'label="Extra loose ' + 'units"',
      'accessibilityLabel="Remove extra ' + 'units"',
      'accessibilityLabel="Add extra loose units"',
      "+ units</Text>",
      "`case of ${upb}`",
      '" / case"',
      "per case`",
      "Added 1 loose",
    ],
    mustContain: [
      'label="Boxes"',
      'label="Extra pieces"',
      'accessibilityLabel="Remove extra pieces"',
      'accessibilityLabel="Add extra pieces"',
      "+ pieces</Text>",
      "`box of ${upb}`",
      '" / box"',
      "pcs per box`",
      "Added 1 pc",
    ],
  },
  {
    file: "components/CartRow.tsx",
    mustNotContain: [
      'label="Cases"',
      'label="Extra loose ' + 'units"',
      'accessibilityLabel="Remove extra ' + 'units"',
      "+ units</Text>",
      "`case of ${upb}`",
      '" / case"',
      "per case`",
      '"units"',
    ],
    mustContain: [
      'label="Boxes"',
      'label="Extra pieces"',
      'accessibilityLabel="Remove extra pieces"',
      "+ pieces</Text>",
      "`box of ${upb}`",
      '" / box"',
      "pcs per box`",
      'label="Total pieces"',
    ],
  },
  {
    file: "components/edit-items/DraftItemCard.tsx",
    mustNotContain: [
      'label="Cases"',
      'label="Extra loose ' + 'units"',
      'accessibilityLabel="Remove extra ' + 'units"',
      'accessibilityLabel="Add extra loose units"',
      "per case`",
      '"units"',
    ],
    mustContain: [
      'label="Boxes"',
      'label="Extra pieces"',
      'accessibilityLabel="Remove extra pieces"',
      'accessibilityLabel="Add extra pieces"',
      "pcs per box`",
      'label="Total pieces"',
      "+ pieces",
    ],
  },
  {
    file: "components/BoxedQtyBand.tsx",
    mustNotContain: [
      "Cases\n",
      "Loose ${unit",
      "Remove extra " + "units",
      "Add extra loose units",
      "+ units</Text>",
    ],
    mustContain: ["Boxes\n", "Extra pieces", "Remove extra pieces", "Add extra pieces", "+ pieces"],
  },
  {
    file: `${INV}/[id]/edit.tsx`,
    mustNotContain: [
      "case of {upb}",
      "case · {line.storedPieces} loose",
      "Units per case",
      '" / case"',
      ">Cases<",
      "Extra loose " + "units",
      "{upb} per case",
      "Remove extra " + "units",
      "Add extra loose units",
      "+ units</Text>",
    ],
    mustContain: [
      "box of {upb}",
      '{line.storedBoxes === 1 ? "box" : "boxes"}',
      '{line.storedPieces === 1 ? "pc" : "pcs"}',
      "Pieces per box",
      '" / box"',
      ">Boxes<",
      "Extra pieces",
      "{upb} pcs per box",
      "Remove extra pieces",
      "Add extra pieces",
      "+ pieces",
    ],
  },
  {
    file: "components/SellByToggle.tsx",
    mustNotContain: ['"Cases" : "Units"'],
    mustContain: ['"Boxes" : "Pieces"'],
  },
  {
    file: "components/ProductRow.tsx",
    mustNotContain: ["` / case of ${upb}`"],
    mustContain: ["` / box of ${upb}`"],
  },
  {
    file: "lib/boxed-line-summary.ts",
    mustNotContain: ['"case${boxes', "} loose`"],
    mustContain: ['"box" : "boxes"', '=== 1 ? "pc" : "pcs"'],
  },
  {
    file: "components/NewOrderScreen.tsx",
    mustNotContain: ["Added 1 loose"],
    mustContain: ["Added 1 pc"],
  },
  {
    file: "components/edit-items/ProductPicker.tsx",
    mustNotContain: ['"1 loose · "'],
    mustContain: ['"1 pc · "'],
  },
  {
    file: "lib/scan-tray.ts",
    mustNotContain: ["`${b} cs + ", "${b} cs`"],
    mustContain: ["`${b} bx + ", "${b} bx`"],
  },
  {
    file: "lib/return-scan-tray.ts",
    mustNotContain: ["${boxes} cs + ", "${boxes} cs`"],
    mustContain: ["${boxes} bx + ", "${boxes} bx`"],
  },
  // Tier B — setup surfaces
  {
    file: "components/ProductForm.tsx",
    mustNotContain: [
      "SKU (case code)",
      "Same as case code",
      "Units per case (optional)",
      "CASE price",
    ],
    mustContain: [
      "SKU (box code)",
      "Same as box code",
      "Pieces per box (optional)",
      "This is the box price",
    ],
  },
  {
    file: "components/InlineCreateProductSheet.tsx",
    mustNotContain: ['"Case price"', "Units per case (optional)", "the CASE price"],
    mustContain: ['"Box price"', "Pieces per box (optional)", "the box price"],
  },
  {
    file: "components/PackSizeSheet.tsx",
    mustNotContain: ['label="Units per case"'],
    mustContain: ['label="Pieces per box"'],
  },
];

// KEEP: identity/behaviour literals and regulated copy the copy change must never touch.
const KEEP: Array<{ file: string; mustContain: string[] }> = [
  { file: "components/SellByToggle.tsx", mustContain: ['export type SellBy = "case" | "unit"'] },
  {
    file: "components/CartRow.tsx",
    mustContain: ['onChangeSellBy: (sellBy: "case" | "unit") => void'],
  },
  { file: "components/ProductForm.tsx", mustContain: ["Case unit of measure"] },
  { file: "components/ProductForm.tsx", mustContain: ['label="Unit code"'] },
  {
    file: `${INV}/new.tsx`,
    mustContain: ["<Text style={styles.unlistedFieldLabel}>Unit price</Text>"],
  },
  {
    file: "components/BoxedQtyBand.tsx",
    mustContain: ["canRemoveLooseUnits", "setLooseUnitsOpen(true)"],
  },
];

describe("VU-1 unit vocabulary: operator copy (mobile)", () => {
  describe.each(CHANGED)("$file", ({ file, mustNotContain, mustContain }) => {
    const src = read(file);
    it.each(mustNotContain)("no longer contains %j", (s) => {
      expect(src).not.toContain(s);
    });
    it.each(mustContain)("now contains %j", (s) => {
      expect(src).toContain(s);
    });
  });

  describe.each(KEEP)("KEEP $file", ({ file, mustContain }) => {
    const src = read(file);
    it.each(mustContain)("still contains %j", (s) => {
      expect(src).toContain(s);
    });
  });
});
