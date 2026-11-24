import { readFileSync } from "fs";
import { join } from "path";

/**
 * BF-1 (SA-1211): a backslash-u escape for the middle dot written as bare JSX text prints the six characters. Inside a
 * string or a `{...}` expression the escape is fine; directly after `}` or `>` it is JSX text. Class guard for the page.
 */
const ESCAPE = String.fromCharCode(92) + "u00b7";

describe("BF-1: no literal middle-dot escape as JSX text on the customer page", () => {
  it("has none directly after a closing brace or tag", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    const bad = src.split("\n").filter((line) => {
      let at = line.indexOf(ESCAPE);
      while (at >= 0) {
        const before = line.slice(0, at).trimEnd();
        if (before.endsWith("}") || before.endsWith(">")) return true;
        at = line.indexOf(ESCAPE, at + 1);
      }
      return false;
    });
    expect(bad).toEqual([]);
  });
});
