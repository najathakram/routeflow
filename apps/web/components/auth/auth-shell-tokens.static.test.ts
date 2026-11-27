/**
 * @jest-environment node
 */
// Sign-up submit button invisible (P1): auth-shell.css named the old site aliases (--b700, --b800,
// --ink-2, --tint ...) that the site rename removed, so `.rf-btn` got an unresolved background and
// white text on white. jsdom does not load stylesheets, so this reads the files: every var() in
// the auth shell must resolve, and the submit button's colour chain must end at a real colour.
import * as fs from "fs";
import * as path from "path";

const WEB = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(p, "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const AUTH_CSS = strip(read(path.join(WEB, "components/auth/auth-shell.css")));
const SOURCES = ["public/site/css/site.css", "public/site/graphics/rf-graphics.css"].map((f) =>
  strip(read(path.join(WEB, f))),
);
const PALETTE = JSON.parse(read(path.resolve(WEB, "../../packages/types/brand/palette.json"))) as {
  color: Record<string, string>;
};

/** name -> value for every custom property the site defines (first definition wins). */
function definitions(): Map<string, string> {
  const out = new Map<string, string>();
  for (const k of Object.keys(PALETTE.color)) out.set(`--brand-${k}`, PALETTE.color[k]);
  for (const css of [...SOURCES, AUTH_CSS]) {
    for (const m of css.matchAll(/(?<![\w-])(--[\w-]+)\s*:\s*([^;}]+)/g)) {
      if (!out.has(m[1])) out.set(m[1], m[2].trim());
    }
  }
  return out;
}

/** Follow var() chains to a literal; null when any link is undefined. */
function resolve(value: string, defs: Map<string, string>, depth = 0): string | null {
  const m = value.match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/);
  if (!m) return value;
  const next = defs.get(m[1]);
  if (next === undefined || depth > 10) return null;
  return resolve(next, defs, depth + 1);
}

/** The value of `prop` in the rule whose selector is exactly `selector` (plain string scan). */
const ruleValue = (css: string, selector: string, prop: string): string => {
  for (const block of css.split("}")) {
    const [sel, body] = block.split("{");
    if (body === undefined || sel.trim() !== selector) continue;
    for (const decl of body.split(";")) {
      const i = decl.indexOf(":");
      if (i > 0 && decl.slice(0, i).trim() === prop) return decl.slice(i + 1).trim();
    }
  }
  throw new Error(`no ${prop} in ${selector}`);
};

describe("auth-shell.css names only custom properties that exist", () => {
  it("every var(--x) without a fallback resolves (no removed --b*, --ink-2, --ink-3, --tint)", () => {
    const defs = definitions();
    const used = [...AUTH_CSS.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)];
    expect(used.length).toBeGreaterThan(20); // a sweep that finds nothing must not pass
    const missing = used.filter((m) => m[2] === ")" && !defs.has(m[1])).map((m) => m[1]);
    expect([...new Set(missing)].sort()).toEqual([]);
  });

  it("the submit button .rf-btn has a real background and a different text colour", () => {
    const defs = definitions();
    const bg = resolve(ruleValue(AUTH_CSS, ".rf-auth .rf-btn", "background"), defs);
    const fg = resolve(ruleValue(AUTH_CSS, ".rf-auth .rf-btn", "color"), defs);
    expect(bg).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
    expect(fg).toMatch(/^#[0-9a-f]{3,8}$/i);
    expect(bg!.slice(0, 7).toLowerCase()).not.toBe("#ffffff");
    expect(bg!.slice(0, 7).toLowerCase()).not.toBe(fg!.slice(0, 7).toLowerCase());
    // alpha, when present, must not be transparent
    if (bg!.length === 9) expect(bg!.slice(7).toLowerCase()).not.toBe("00");
  });
});
