import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-626a: the "Which one?" sheet is an operator picker TAP, and picker taps start on the DEFAULT selling unit
 * (SA-601(4)/610/617): onSelect asks for startOnDefault, exactly like the cart row's add.
 */
const screen = readFileSync(join(__dirname, "..", "components", "NewOrderScreen.tsx"), "utf8");

describe("ambiguous-scan picker (mobile)", () => {
  it("onSelect adds the chosen product starting on the default unit", () => {
    const sel = screen.slice(screen.indexOf("onSelect={(p: { id: string })"));
    expect(sel.slice(0, 260)).toMatch(
      /acceptScannedProduct\(p as unknown as Product, "BOX", \{ startOnDefault: true \}\)/,
    );
  });
});
