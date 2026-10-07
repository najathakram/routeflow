/**
 * #2698 PR-2 (SA-564): the owner's one-unit-sold rule on every other mobile SALE surface with a
 * Cases + Loose pair — the new-order picker's "On this order" band (BoxedQtyBand), the operator
 * new-invoice cart line (invoices/new.tsx) and the order-edit draft card (DraftItemCard). Each uses
 * the SAME two helpers as CartRow (#2706; lib/loose-units.ts — never a second rule):
 *   - the loose control is hidden unless "+ pieces" was tapped or the line carries pieces;
 *   - "Remove extra pieces" exists only with >= 1 case, and sets pieces to 0 explicitly.
 * Source-text pins (no renderer under mobile Jest), one set per surface; the payload rules are
 * pinned once, in cartrow-one-unit-sold-2698.test.ts. Driver stop-adjust is out of scope (lead).
 */
import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

const SURFACES: Array<{ name: string; file: string; pieces: RegExp; setPiecesZero: RegExp }> = [
  {
    name: "BoxedQtyBand (new-order picker band)",
    file: "components/BoxedQtyBand.tsx",
    pieces: /looseUnitsVisible\(\s*looseUnitsOpen,\s*line\.pieces\s*\)/,
    setPiecesZero: /onChangePieces\(0\)/,
  },
  {
    name: "invoices/new.tsx cart line",
    file: "app/(operator)/(tabs)/invoices/new.tsx",
    pieces: /looseUnitsVisible\(\s*looseUnitsOpen,\s*line\.pieces\s*\)/,
    setPiecesZero: /onChangePieces\(0\)/,
  },
  {
    name: "invoices/[id]/edit.tsx line card (SA-564a)",
    file: "app/(operator)/(tabs)/invoices/[id]/edit.tsx",
    pieces: /looseUnitsVisible\(\s*looseUnitsOpen,\s*line\.pieces\s*\)/,
    setPiecesZero: /onSetPieces\(0\)/,
  },
  {
    name: "DraftItemCard",
    file: "components/edit-items/DraftItemCard.tsx",
    pieces: /looseUnitsVisible\(\s*looseUnitsOpen,\s*item\.pieces\s*\)/,
    setPiecesZero: /onSetPieces\(0\)/,
  },
];

describe.each(SURFACES)("#2698 PR-2 — $name", ({ file, pieces, setPiecesZero }) => {
  const src = read(file);

  it("uses the shared rule from lib/loose-units (never a second one)", () => {
    expect(src).toMatch(/from "[./]+\/?(lib\/)?loose-units"|loose-units";/);
    expect(src).toMatch(/looseUnitsVisible/);
    expect(src).toMatch(/canRemoveLooseUnits/);
  });

  it("the loose control is hidden by default: shown only by looseUnitsVisible(open, pieces)", () => {
    expect(src).toMatch(/useState\(false\)/);
    expect(src).toMatch(pieces);
  });

  it("a small '+ pieces' control opens it", () => {
    expect(src).toMatch(/\+ pieces/);
    expect(src).toMatch(/setLooseUnitsOpen\(true\)/);
  });

  it("'Remove extra pieces' only with >= 1 case, and it sets pieces to 0 explicitly", () => {
    expect(src).toMatch(/canRemoveLooseUnits\(\s*(line|item)\.boxes\s*\)\s*\?/);
    expect(src).toMatch(/accessibilityLabel="Remove extra pieces"/);
    expect(src).toMatch(setPiecesZero);
  });
});

describe("#2698 PR-2 — lead nit on CartRow (#2706)", () => {
  it("the '+ pieces' control carries hitSlop={8} (a >= 44px effective target)", () => {
    const src = read("components/CartRow.tsx");
    const block = src.slice(src.indexOf("setLooseUnitsOpen(true)") - 200, src.indexOf("+ pieces"));
    expect(block).toMatch(/hitSlop=\{8\}/);
  });
});

// SA-564a (a): BoxedQtyBand changes ONCE and every consumer follows — each renders the shared band
// for its Cases + Loose pair, never a second, band-local loose stepper.
describe.each([
  ["NewOrderScreen (the picker)", "components/NewOrderScreen.tsx"],
  ["invoices/new.tsx (the picker)", "app/(operator)/(tabs)/invoices/new.tsx"],
  ["VariantSplitSheet", "components/VariantSplitSheet.tsx"],
])("#2698 PR-2 — %s uses the shared BoxedQtyBand", (_name, file) => {
  it("renders <BoxedQtyBand (which carries the opt-in rule)", () => {
    const src = read(file);
    expect(src).toMatch(/import \{ BoxedQtyBand \} from "[./]+\/?(components\/)?BoxedQtyBand"/);
    expect(src).toMatch(/<BoxedQtyBand/);
  });
});
