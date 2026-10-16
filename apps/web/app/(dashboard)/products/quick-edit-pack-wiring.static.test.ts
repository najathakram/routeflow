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
    expect(list).toMatch(/updateProduct\.mutateAsync\(\{ id: product\.id, \.\.\.pack\.save \}\)/);
    expect(list).toMatch(/oldValue: pack\.undo,\s*newValue: pack\.redo/);
  });
});
