/**
 * #2329 (T0.1): `globals.css` cannot import TypeScript, so this pins it to the one Ledger token
 * source (`packages/ui/src/tokens/ledger.ts`) the way enum-parity.spec.ts pins Prisma enums
 * (L-072). Every custom property in `:root` and `.surface-buyer` must equal what
 * `ledgerCssVars()` says, and neither side may carry a var the other lacks.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { ledgerCssVars } from "@routeflow/ui/ledger";

const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");

/** The custom properties declared directly inside `selector { … }` (comments stripped). */
function block(selector: string): Record<string, string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = clean.search(new RegExp(`(^|\\n)${selector.replace(".", "\\.")}\\s*\\{`));
  if (at < 0) throw new Error(`${selector} not found in globals.css`);
  const open = clean.indexOf("{", at);
  const body = clean.slice(open + 1, clean.indexOf("}", open));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1]] = m[2].replace(/\s+/g, " ").trim();
  }
  return vars;
}

describe("globals.css ⇄ Ledger token source (#2329)", () => {
  it.each([
    [":root", "operator"],
    [".surface-buyer", "buyer"],
  ] as const)("%s matches ledgerCssVars(%s) exactly", (selector, surface) => {
    expect(block(selector)).toEqual(ledgerCssVars(surface));
  });
});
