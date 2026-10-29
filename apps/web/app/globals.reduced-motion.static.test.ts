import * as fs from "fs";
import * as path from "path";

/** W-928: dialogs, drawers and popovers stop animating under prefers-reduced-motion. A static scan: jsdom runs no CSS. */
const css = fs.readFileSync(path.resolve(__dirname, "globals.css"), "utf8");

describe("globals.css reduced motion (W-928)", () => {
  it("switches the Tailwind enter and exit animations off under prefers-reduced-motion: reduce", () => {
    const block = css.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.animate-in,\s*\.animate-out\s*\{([^}]*)\}/,
    );
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/animation:\s*none\s*!important/);
  });
});
