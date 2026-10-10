import fs from "fs";
import path from "path";

/**
 * #2211 (1): the import cards sat in a bare `grid grid-cols-2` at every width, so at 390px the
 * second card clipped and button labels wrapped to three lines. They stack below lg now. jsdom
 * has no layout, so this pins the class wiring; the 320-430px proof is a Playwright capture.
 */
const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("#2211 — settings/import cards stack on narrow screens", () => {
  it("has no unconditional two-column grid", () => {
    expect(src).not.toMatch(/className="grid grid-cols-2 gap-5"/);
  });

  it("uses one column below lg and two from lg up", () => {
    expect(src).toMatch(/className="grid grid-cols-1 gap-5 lg:grid-cols-2"/);
  });
});
