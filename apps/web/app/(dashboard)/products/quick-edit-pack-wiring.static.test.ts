import * as fs from "fs";
import * as path from "path";

/**
 * SA-797a MUST-1: the products list Quick Edit "Pieces per box" cell sent `unitsPerBox` as a string with no
 * expected pack, so every save was a 409 PRODUCT_PACK_PRECONDITION_REQUIRED (and "6" a 400). The page is not
 * mountable here; the patch shape is pinned in lib/quick-edit-pack.test.ts, the wiring here.
 */
const list = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("Quick Edit pieces-per-box goes through quickPackEdit on save, undo and redo", () => {
  it("the unitsPerBox save uses quickPackEdit and records its undo / redo patches", () => {
    expect(list).toMatch(/import \{ quickPackEdit \} from "@\/lib\/quick-edit-pack";/);
    expect(list).toMatch(
      /if \(field === "unitsPerBox"\) \{\s*const pack = quickPackEdit\(product, newVal\);/,
    );
    expect(list).toMatch(/packSave\.mutateAsync\(\{ id: product\.id, \.\.\.pack\.save \}, stock\)/);
    expect(list).toMatch(/oldValue: pack\.undo,\s*newValue: pack\.redo/);
  });

  it("an invalid size sends NO PATCH: the error toast and `return false` come before mutateAsync, the cell is type=number min 1 step 1", () => {
    const block = list.slice(list.indexOf('if (field === "unitsPerBox") {'));
    const invalid = block.indexOf("if (!pack.ok) {");
    expect(invalid).toBeGreaterThan(-1);
    expect(block.indexOf("toast({ title: pack.message")).toBeGreaterThan(invalid);
    expect(block.indexOf("return false;")).toBeGreaterThan(invalid);
    // order: guard < toast < return false < the one mutateAsync of this branch
    expect(block.indexOf("return false;")).toBeLessThan(block.indexOf("packSave.mutateAsync"));
    expect(list).toMatch(/field="unitsPerBox"\s*type="number"\s*min=\{1\}\s*step=\{1\}/);
  });

  it("a click on the pack cell stops at the cell: the row click would open the product, and the first-pack question lives on this page", () => {
    expect(list).toMatch(
      /<div onClick=\{\(e\) => e\.stopPropagation\(\)\}>\s*<QuickEditCell\s*productId=\{p\.id\}\s*productName=\{p\.name\}\s*field="unitsPerBox"/,
    );
  });

  it("W-1 (SA-1093): no Quick Edit cell sits outside a stop, so a click never opens the product", () => {
    const cells = list.split("<QuickEditCell").slice(0, -1);
    expect(cells.length).toBeGreaterThanOrEqual(5);
    const open = cells.filter(
      (before) => !/onClick=\{\(e\) => e\.stopPropagation\(\)\}>\s*$/.test(before),
    );
    expect(open).toEqual([]);
  });
});
