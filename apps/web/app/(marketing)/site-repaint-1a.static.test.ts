/**
 * @jest-environment node
 */
// Repaint, lane 2.1a: the seven files of this lane carry no retired token (T14b, scoped), no gradient, blur,
// glow or shadow other than the one-pixel ring (T18a, scoped), no typed colour, and every band resolves to
// white, bone or ink (T15, static form). Files that other lanes still own are DATA rows with their lane and
// wave: each later lane deletes its row as it cleans, and a row for a file that is already clean fails.
import * as fs from "fs";
import * as path from "path";

const WEB = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const MINE = [
  "public/site/css/home-color.css",
  "public/site/css/color-deep.css",
  "public/site/css/product.css",
  "public/site/css/company.css",
  "public/site/css/does.css",
  "public/site/css/start.css",
  "components/site-frame/site-frame.css",
];

const allSiteCss = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(WEB, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".css")) out.push(rel);
    }
  };
  walk("public/site");
  out.push("components/site-frame/site-frame.css");
  return out;
};

// The names the ux-spec retires (section 3), as references or definitions.
const RETIRED =
  /(?<![\w-])--(?:rf-brand-\d+|rf-on-navy|rf-link-on-navy|rf-tint|rf-ink-[23]|rf-sun(?:-soft)?|rf-coral(?:-soft)?|rf-mint(?:-soft)?|rf-ok|rf-sh-(?:card|sample|win)|pc-[a-z]+|fld-[a-z]+|k-(?:bg|ink|dot)|navy(?:-d)?|sun|tint)(?![\w-])/g;
// Aliases that site.css points at retired names. This lane's files avoid them too (jobs only).
const ALIASES =
  /(?<![\w-])--(?:ink-[23]|b(?:50|300|500|600|700|800)|sun-t|coral(?:-t)?|sky(?:-t)?)(?![\w-])/g;

const refs = (file: string, re: RegExp) => [...new Set(stripComments(read(file)).match(re) ?? [])];

// Files outside this lane that still reference a retired name today (scanned 2026-11-14).
const T14B_ROWS: Array<{ file: string; lane: string; wave: string }> = [];

// Files outside this lane that still hold a gradient, blur, glow or non-ring shadow today.
const T18A_ROWS: Array<{ file: string; lane: string; wave: string }> = [];

const flatOffences = (file: string): string[] => {
  const css = stripComments(read(file));
  const out: string[] = [];
  for (const word of ["gradient(", "drop-shadow", "blur(", "text-shadow"]) {
    if (css.includes(word)) out.push(word);
  }
  for (const m of css.matchAll(/box-shadow\s*:\s*([^;}]*)/g)) {
    const v = m[1].trim();
    if (v !== "var(--rf-ring)" && v !== "none") out.push(`box-shadow:${v}`);
  }
  return out;
};

describe("T14b scoped: no retired token in this lane's files", () => {
  it.each(MINE)("%s references no retired name or alias of one", (file) => {
    expect(refs(file, RETIRED)).toEqual([]);
    expect(refs(file, ALIASES)).toEqual([]);
  });

  // An empty table is fine (every file is clean): it.each throws on no rows, so the block is conditional.
  if (T14B_ROWS.length > 0) {
    it.each(T14B_ROWS.map((r) => [r.file, r.lane, r.wave]))(
      "%s still references a retired name (owned by %s, %s): a clean file loses its row",
      (file) => {
        expect(refs(file, RETIRED).length).toBeGreaterThan(0);
      },
    );
  }

  it("no other site CSS file references a retired name without a row", () => {
    const rows = new Set(T14B_ROWS.map((r) => r.file));
    for (const file of allSiteCss()) {
      if (MINE.includes(file) || rows.has(file)) continue;
      expect({ file, refs: refs(file, RETIRED) }).toEqual({ file, refs: [] });
    }
  });

  it("every row names a real css file once, with a lane and a wave", () => {
    const files = T14B_ROWS.map((r) => r.file);
    expect(new Set(files).size).toBe(files.length);
    for (const r of T14B_ROWS) {
      expect(allSiteCss()).toContain(r.file);
      expect(MINE).not.toContain(r.file);
      expect(r.lane).toMatch(/\S/);
      expect(r.wave).toMatch(/^W\d/);
    }
  });
});

describe("T18a scoped: flat, one ring", () => {
  it.each(MINE)("%s has no gradient, blur, glow or shadow other than the ring", (file) => {
    expect(flatOffences(file)).toEqual([]);
  });

  // An empty table is fine (every file is flat): it.each throws on no rows, so the block is conditional.
  if (T18A_ROWS.length > 0) {
    it.each(T18A_ROWS.map((r) => [r.file, r.lane, r.wave]))(
      "%s is still not flat (owned by %s, %s): a flat file loses its row",
      (file) => {
        expect(flatOffences(file).length).toBeGreaterThan(0);
      },
    );
  }

  it("no other site CSS file is un-flat without a row", () => {
    const rows = new Set(T18A_ROWS.map((r) => r.file));
    for (const file of allSiteCss()) {
      if (MINE.includes(file) || rows.has(file)) continue;
      expect({ file, offences: flatOffences(file) }).toEqual({ file, offences: [] });
    }
  });

  it("every row names a real css file once", () => {
    const files = T18A_ROWS.map((r) => r.file);
    expect(new Set(files).size).toBe(files.length);
    for (const r of T18A_ROWS) {
      expect(allSiteCss()).toContain(r.file);
      expect(MINE).not.toContain(r.file);
    }
  });
});

// A small rule reader: top-level rules and the rules inside @media / @supports.
type Rule = { selectors: string[]; decls: Record<string, string> };
const rulesOf = (css: string): Rule[] => {
  const out: Rule[] = [];
  const walk = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith("@media") || head.startsWith("@supports")) walk(body);
      else if (!head.startsWith("@")) {
        const decls: Record<string, string> = {};
        for (const d of body.split(";")) {
          const k = d.indexOf(":");
          if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
        }
        out.push({ selectors: head.split(",").map((s) => s.trim()), decls });
      }
      i = j;
    }
  };
  walk(stripComments(css));
  return out;
};

describe("T15 static: colour only through tokens; every band is white, bone or ink", () => {
  it.each(MINE)("%s types no colour literal in a declaration", (file) => {
    const bad: string[] = [];
    for (const r of rulesOf(read(file))) {
      for (const [prop, value] of Object.entries(r.decls)) {
        if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/i.test(value)) {
          bad.push(`${r.selectors[0]} { ${prop}: ${value} }`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  // Band-level selectors in this lane's files (the section backgrounds), by file.
  const BANDS: Record<string, string[]> = {
    "public/site/css/color-deep.css": [
      ".pd .pd-top",
      ".pd .pd-all",
      ".pd .pd-how",
      ".pd .pd-who",
      ".pd .pd-grow",
      ".pd .gs-people",
      ".pd .co-story",
      ".pd .co-ask",
      ".pd .pd-deep",
    ],
    "public/site/css/product.css": [".pd-how", ".pd-who", ".pd-deep"],
    "public/site/css/home-color.css": [
      ".home .sl",
      ".home .jr",
      ".home .st",
      ".home .ct",
      ".home .inc",
      ".home .fq",
    ],
    "components/site-frame/site-frame.css": [".rf-frame", ".rf-frame-main--narrow"],
  };
  const THREE = new Set(["var(--rf-white)", "var(--rf-soft)", "var(--rf-panel)"]);

  it.each(Object.entries(BANDS))("%s: each band background is white, bone or ink", (file, sels) => {
    const rules = rulesOf(read(file));
    for (const sel of sels) {
      const hits = rules.filter((r) => r.selectors.includes(sel));
      const painted = hits.filter((r) => r.decls.background || r.decls["background-color"]);
      expect({ sel, painted: painted.length > 0 }).toEqual({ sel, painted: true });
      for (const r of hits) {
        const v = r.decls.background ?? r.decls["background-color"];
        if (v !== undefined) expect({ sel, v, ok: THREE.has(v) }).toEqual({ sel, v, ok: true });
        expect(r.decls["background-image"]).toBeUndefined();
      }
    }
  });

  it("the three tokens are the only band colours the repaint names", () => {
    const text = MINE.map(read).join("\n");
    expect(text).not.toMatch(/--rf-(?:brand|sun|coral|mint)/);
  });
});

describe("review fixes: disc, hero figure, dark-panel pairs", () => {
  const ruleFor = (file: string, sel: string) =>
    rulesOf(read(file)).filter((r) => r.selectors.includes(sel));
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const PAL = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../../../packages/types/brand/palette.json"),
      "utf8",
    ),
  ).color as Record<string, string>;
  // Job token to palette colour (the job table in rf-graphics.css).
  const JOB: Record<string, string> = {
    "var(--rf-text)": PAL.ink,
    "var(--rf-panel)": PAL.ink,
    "var(--rf-on-panel)": PAL.white,
    "var(--rf-on-panel-2)": PAL.bone,
    "var(--rf-soft)": PAL.bone,
    "var(--rf-white)": PAL.white,
  };

  it("the founder monogram disc differs from the panel it sits on and keeps AA letters", () => {
    const r = ruleFor("public/site/css/home-color.css", "#founder .fd-mono");
    expect(r.length).toBe(1);
    const bg = r[0].decls.background;
    const fg = r[0].decls.color;
    expect(bg).not.toBe("var(--rf-panel)");
    expect(JOB[bg]).not.toBe(JOB["var(--rf-panel)"]);
    expect(ratio(JOB[bg], JOB[fg])).toBeGreaterThanOrEqual(4.5);
  });

  it("the hero figure on the two diagram pages stays centred against the text column", () => {
    const r = ruleFor("public/site/css/does.css", ".pd-top .dd-flow");
    expect(r.some((x) => x.decls["align-self"] === "center")).toBe(true);
  });

  it("each dark-panel text rule names its intended pair and that pair is AA", () => {
    const pairs: Array<[string, string, string, string]> = [
      ["public/site/css/product.css", ".pd-deep", "background", "color"],
    ];
    const deep = ruleFor("public/site/css/product.css", ".pd-deep")[0].decls;
    expect(deep.background).toBe("var(--rf-panel)");
    expect(deep.color).toBe("var(--rf-on-panel)");
    expect(ratio(JOB[deep.background], JOB[deep.color])).toBeGreaterThanOrEqual(4.5);
    expect(pairs.length).toBe(1);
    const sub = ruleFor("public/site/css/product.css", ".pd-deep .sub")[0].decls;
    expect(sub.color).toBe("var(--rf-on-panel-2)");
    expect(ratio(JOB["var(--rf-panel)"], JOB[sub.color])).toBeGreaterThanOrEqual(4.5);
    // the label on the dark panel is a bone pill with ink text, so its pair is ink on bone
    const kickBg = ruleFor("public/site/css/color-deep.css", ".pd .kick")[0].decls.background;
    const kickFg = ruleFor("public/site/css/product.css", ".pd-head--deep .kick")[0].decls.color;
    expect(kickBg).toBe("var(--rf-soft)");
    expect(kickFg).toBe("var(--rf-text)");
    expect(ratio(JOB[kickBg], JOB[kickFg])).toBeGreaterThanOrEqual(4.5);
  });

  it("the legal table does not double its last line against the wrapper ring", () => {
    const css = read("components/site-frame/site-frame.css");
    expect(css).toMatch(/tbody tr:last-child\s*td[\s\S]*?border-bottom:\s*0/);
  });
});
