import fs from "fs";
import path from "path";

/**
 * #2211 (2): the New Inventory Purchase modal put Bill Date / Terms / Due Date in a bare
 * `grid grid-cols-3`. At 320px the modal body is ~272px, so each cell is ~80px — narrower than a
 * date input's intrinsic width — and the row ran ~40px past the viewport. The row stacks below sm
 * now. This page has no render harness (see scanner-refocus-wiring-b744.test.ts), so this pins
 * the class wiring; the 320-430px proof is a Playwright capture.
 */
const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("#2211 — vendor-bill modal date row stacks at narrow widths", () => {
  it("has no unconditional three-column grid", () => {
    expect(src).not.toMatch(/className="grid grid-cols-3 gap-3"/);
  });

  it("the Bill Date / Terms / Due Date row is one column below sm, three from sm up", () => {
    expect(src).toMatch(
      /className="grid grid-cols-1 gap-3 sm:grid-cols-3">\s*<div>\s*<label[^>]*>Bill Date</,
    );
  });
});
