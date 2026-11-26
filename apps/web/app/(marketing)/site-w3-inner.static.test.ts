/**
 * @jest-environment node
 */
// Lane 2.3-inner, static rows: the use-case tiles are white on a line with a bone icon chip and an ink
// icon (ux-spec section 5), and the product headline's no-break tail is lifted on a phone so it cannot
// run past the column. Reads product.css; the role names are the page's own tokens.
import * as fs from "fs";
import * as path from "path";

const css = fs.readFileSync(path.resolve(__dirname, "../../public/site/css/product.css"), "utf8");

/** The declaration block of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)${esc}\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`product.css has no rule for ${selector}`);
  return m[1];
}

describe("2.3-inner: tiles and the headline tail", () => {
  test("a tile is white with the one-pixel ring", () => {
    const r = rule(".pd-tile");
    expect(r).toMatch(/background:var\(--rf-white\)/);
    expect(r).toMatch(/box-shadow:var\(--rf-ring\)/);
  });

  test("a tile's icon chip is bone and its icon is ink text", () => {
    expect(rule(".pd-tile .pd-ic")).toMatch(/background:var\(--rf-soft\)/);
    expect(rule(".pd-ic")).toMatch(/color:var\(--rf-text\)/);
  });

  test("the hover swaps the two surfaces", () => {
    expect(rule(".pd-tile:hover")).toMatch(/background:var\(--rf-soft\)/);
    expect(rule(".pd-tile:hover .pd-ic")).toMatch(/background:var\(--rf-white\)/);
  });

  test("the headline's no-break tail is lifted under 900px", () => {
    expect(css).toMatch(/@media \(max-width:899\.98px\)\{#pd-h \.nb\{white-space:normal\}\}/);
  });
});
