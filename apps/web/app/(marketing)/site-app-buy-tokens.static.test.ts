/**
 * @jest-environment node
 */
// T21, second half (SA-1183 K2): every `--app-*` and `--buy-*` token of the product pictures resolves to a palette or
// status token of the token block, and none holds a `#` literal. The values are read from rf-graphics.css and
// palette.json at test time; a sweep that finds nothing throws (L-202).
import * as fs from "fs";
import * as path from "path";

const SITE = path.resolve(__dirname, "../../public/site");
const css = fs
  .readFileSync(path.join(SITE, "graphics/rf-graphics.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const PALETTE = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../../packages/types/brand/palette.json"), "utf8"),
) as { color: Record<string, string> };

/** Every `--x:value` declaration in the file, in order, each with the text of the block it sits in. */
const declarations = (): Array<{ name: string; value: string }> =>
  [...css.matchAll(/(?<![\w-])(--[\w-]+)\s*:\s*([^;}]+)/g)].map((m) => ({
    name: m[1] as string,
    value: (m[2] as string).trim(),
  }));

/** A `--rf-<key>` palette or status token: the token block defines it as `var(--brand-<key>)`, and the key is in palette.json. */
const paletteTokens = (): Set<string> => {
  const out = new Set<string>();
  for (const d of declarations()) {
    const m = /^var\(\s*--brand-([\w-]+)\s*\)$/.exec(d.value);
    if (m && d.name.startsWith("--rf-") && (m[1] as string) in PALETTE.color) out.add(d.name);
  }
  return out;
};

/** A font stack: a comma list ending in a generic family, or the one var() of the --rf-font token; never a colour. */
const isFontStack = (v: string) =>
  v === "var(--rf-font)" ||
  (v.includes(",") && /(?:sans-serif|serif|monospace)$/.test(v) && !v.includes("#"));

/** The picture-token :root block (it follows the "Pictures of the product only" comment); `--app` and `--mono` must be font stacks and are returned apart from the colours. */
const blockAll = (): Array<{ name: string; value: string }> => {
  const raw = fs.readFileSync(path.join(SITE, "graphics/rf-graphics.css"), "utf8");
  const at = raw.indexOf("Pictures of the product only");
  const open = at < 0 ? -1 : raw.indexOf(":root{", at);
  const close = open < 0 ? -1 : raw.indexOf("\n}", open);
  if (close < 0) throw new Error("the picture-token :root block was not found");
  const text = raw.slice(open, close).replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/(?<![\w-])(--[\w-]+)\s*:\s*([^;}]+)/g)].map((m) => ({
    name: m[1] as string,
    value: (m[2] as string).trim(),
  }));
};
const isFontToken = (d: { name: string }) => d.name === "--app" || d.name === "--mono";
const fonts = () => blockAll().filter(isFontToken);
const block = () => blockAll().filter((d) => !isFontToken(d));

/** Every picture token: the whole block whatever its prefix, plus the --app-/--buy- overrides outside it. */
const picture = () => {
  const inBlock = block();
  const names = new Set(inBlock.map((d) => d.name + d.value));
  const extra = declarations().filter(
    (d) => /^--(?:app|buy)-/.test(d.name) && !names.has(d.name + d.value),
  );
  return [...inBlock, ...extra];
};

describe("T21: the product pictures' colours are palette or status values", () => {
  it("finds the tokens (a sweep that finds nothing throws)", () => {
    const found = picture();
    if (found.length < 20)
      throw new Error(`expected the --app-* and --buy-* block, found ${found.length}`);
    expect(paletteTokens().size).toBeGreaterThanOrEqual(11);
    expect(found.some((d) => d.name.startsWith("--buy-"))).toBe(true);
  });

  it("--app and --mono are font stacks, not colours", () => {
    const found = fonts();
    expect(found.map((d) => d.name).sort()).toEqual(["--app", "--mono"]);
    expect(found.filter((d) => !isFontStack(d.value)).map((d) => `${d.name}: ${d.value}`)).toEqual(
      [],
    );
  });

  it("no picture-token declaration holds a # literal", () => {
    expect(picture().filter((d) => d.value.includes("#"))).toEqual([]);
  });

  it("every picture-token declaration is one var() of a palette or status token (or of another picture token)", () => {
    const ok = paletteTokens();
    const bad = picture().filter((d) => {
      const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(d.value);
      return !m || !(ok.has(m[1] as string) || /^--(?:app|buy)-/.test(m[1] as string));
    });
    expect(bad.map((d) => `${d.name}: ${d.value}`)).toEqual([]);
  });

  it("the primary of the operator and buyer pictures is one token (buttons are ink)", () => {
    const value = (name: string) => picture().find((d) => d.name === name)?.value;
    expect(value("--app-p")).toBe("var(--rf-ink)");
    expect(value("--buy-p")).toBe(value("--app-p"));
  });

  it("the checker goes red on a literal and on a job token (fixtures)", () => {
    const ok = paletteTokens();
    const passes = (v: string) => {
      const m = /^var\(\s*(--rf-[\w-]+)\s*\)$/.exec(v);
      return !!m && ok.has(m[1] as string) && !v.includes("#");
    };
    expect(passes("#0e8480")).toBe(false);
    expect(passes("var(--rf-accent)")).toBe(false);
    expect(passes("var(--rf-copper)")).toBe(true);
  });
});
