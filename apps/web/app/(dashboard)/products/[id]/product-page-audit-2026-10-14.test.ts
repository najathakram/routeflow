import * as fs from "fs";
import * as path from "path";
import { deleteProductConfirmText } from "@routeflow/types";

/**
 * Product page audit 2026-10-14. Source pins: the page is ~2.9k lines and not worth mounting for these wirings.
 */
const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
const page = read("page.tsx");
const header = read("ProductHeaderControls.tsx");

describe("role gate (owner ruling): every product control is for staff", () => {
  it("the page and the header gate on isStaffRole, never on role === OPERATOR", () => {
    for (const src of [page, header]) {
      expect(src).toMatch(/const isStaff = isStaffRole\(user\?\.role\);/);
      expect(src).not.toMatch(/role === "OPERATOR"/);
      expect(src).not.toMatch(/\bisOperator\b(?!=)/);
    }
  });
});

describe("dead controls", () => {
  it("'Variant of: None' on a linked product sends the unlink (the Unlink button's write)", () => {
    expect(page).toMatch(
      /: product\.parentProductId\s*\?[\s\S]{0,200}\{ parentProductId: null, variantName: null \}/,
    );
  });

  it("'assign name' opens the form on the Flavor / variety field, which a product with variants now shows", () => {
    expect(page).toMatch(/onClick=\{assignOwnName\}[\s\S]{0,300}assign name/);
    expect(page).toMatch(
      /startEdit\(\);\s*requestAnimationFrame\(\(\) => document\.getElementById\(VARIANT_NAME_INPUT_ID\)\?\.focus\(\)\)/,
    );
    expect(page).toMatch(/!product\.parentProductId && \(product\.variants\?\.length \?\? 0\) > 0/);
    expect(page).toMatch(/id=\{VARIANT_NAME_INPUT_ID\}/);
    expect(page).toMatch(/\{ variantName: draft\.variantName\?\.trim\(\) \|\| null \}/);
  });
});

describe("image delete is confirmed (the file is deleted for good; no undo exists)", () => {
  it("the single and bulk delete buttons only queue keys for the confirm", () => {
    expect(page).toMatch(/if \(key\) setPendingImageDelete\(\[key\]\);/);
    expect(page).toMatch(/if \(toDelete\.length > 0\) setPendingImageDelete\(toDelete\);/);
  });

  it("deleteImage runs only from the confirm (and the crop replace), never straight from a click", () => {
    const calls = page.match(/deleteImage\.mutateAsync\(/g) ?? [];
    expect(calls).toHaveLength(2); // confirmImageDelete's loop + the crop replace of the old key
    expect(page).toMatch(/onConfirm=\{confirmImageDelete\}/);
    expect(page).toMatch(/deleted for good\. This can't be undone\./);
  });
});

describe("delete copy: web and mobile share one sentence, and it never says 'permanently'", () => {
  it("deleteProductConfirmText describes the deactivation", () => {
    const text = deleteProductConfirmText("Cola 12pk");
    expect(text).toMatch(/^Cola 12pk will be deactivated/);
    expect(text).not.toMatch(/permanent/i);
  });

  it("both confirms use it", () => {
    expect(read("DeleteProductConfirm.tsx")).toMatch(
      /description=\{deleteProductConfirmText\(name\)\}/,
    );
    const mobile = fs.readFileSync(
      path.join(__dirname, "../../../../../mobile/app/(operator)/products/[id].tsx"),
      "utf8",
    );
    expect(mobile).toMatch(/deleteProductConfirmText\(product\.name\)/);
    expect(mobile).not.toMatch(/removed permanently/);
  });
});
