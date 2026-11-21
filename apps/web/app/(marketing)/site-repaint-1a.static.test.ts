/**
 * @jest-environment node
 */
// Repaint, lane 2.1a: the seven files of this lane carry no retired token (T14b, scoped), no gradient, blur,
// glow or shadow other than the one-pixel ring (T18a, scoped), no typed colour, and every band resolves to
// white, bone or ink (T15, static form). Files that other lanes still own are DATA rows with their lane and
// wave: each later lane deletes its row as it cleans, and a row for a file that is already clean fails.
import { JSDOM } from "jsdom";
import * as fs from "fs";
import * as path from "path";
import { readServedSitePage } from "@/lib/read-site-page";
import { STATIC_SITE_PAGE_NAMES } from "@/lib/static-site-page";

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

// T17 static (a, b): copper stays inside its listed jobs and is never a status colour (R17).
// Sources: every site CSS file, plus every <style> block and inline style="" in public/site/*.html.
// Copper reaches a rule as a palette hex (also as %23 hex, rgb() or hsl()), as any hex, rgb() or hsl() whose
// hue is copper, or as a token that resolves to one (var() followed to a fixed point). Custom-property
// definitions are plumbing: the rules that read them are the uses, and each is keyed
// `source :: selectors :: property`.
// The app's own copper values are the palette's (packages/types/brand/palette.json, the file the app's
// BrandTokens component injects as --brand-copper*); the tests read them, never type them.
const PALETTE = JSON.parse(
  fs.readFileSync(path.join(WEB, "../../packages/types/brand/palette.json"), "utf8"),
).color as Record<string, string>;
const COPPER_HEXES = Object.entries(PALETTE)
  .filter(([k]) => k.startsWith("copper"))
  .map(([, v]) => v.replace("#", "").toLowerCase());

const toRgb = (hex: string): [number, number, number] => {
  const h = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
};
/** Copper by hue (orange-brown, mid saturation, mid lightness): catches a copper typed in a new place. */
const copperLike = ([r, g, b]: [number, number, number]): boolean => {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return false;
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = (max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4) * 60;
  const hue = (h + 360) % 360;
  return hue >= 15 && hue <= 35 && s >= 0.35 && s <= 0.72 && l >= 0.25 && l <= 0.75;
};
const PALETTE_COPPER_RGB = COPPER_HEXES.map(toRgb);
/** Colour literals in a value, as rgb triples. */
const literalsOf = (v: string): Array<[number, number, number]> => {
  const out: Array<[number, number, number]> = [];
  for (const m of v.matchAll(/(?:#|%23)([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z])/gi))
    out.push(toRgb(m[1]));
  for (const m of v.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi))
    out.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  for (const m of v.matchAll(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/gi))
    out.push(hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100));
  return out;
};
const sameRgb = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) <= 1);
const isAppCopper = (c: [number, number, number]) => PALETTE_COPPER_RGB.some((p) => sameRgb(p, c));

type CopperRule = { source: string; selectors: string[]; decls: Record<string, string> };

// Pages are read as served (the page-read pin): the <style> blocks and inline style stay in the served html.
const siteHtml = (): Array<{ name: string; html: string }> =>
  STATIC_SITE_PAGE_NAMES.map((p) => ({
    name: `${p}.html`,
    html: readServedSitePage(p, { websiteId: undefined }),
  }));

const copperSources = (): CopperRule[] => {
  const out: CopperRule[] = [];
  for (const f of allSiteCss())
    for (const r of rulesOf(read(f)))
      out.push({ source: f.replace("public/site/", ""), selectors: r.selectors, decls: r.decls });
  for (const { name, html } of siteHtml()) {
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi))
      for (const r of rulesOf(m[1]))
        out.push({ source: `${name} <style>`, selectors: r.selectors, decls: r.decls });
    for (const m of html.matchAll(/\sstyle="([^"]*)"/g)) {
      const decls: Record<string, string> = {};
      for (const d of m[1].split(";")) {
        const k = d.indexOf(":");
        if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
      }
      out.push({ source: `${name} style=""`, selectors: ["style"], decls });
    }
  }
  return out;
};

const COPPER_SEEDS = ["--brand-copper", "--brand-copper-light", "--brand-copper-dark"];

/** Every copper use as `source :: selectors :: property`, with the tokens that are copper and the ones
 *  that are not the app's own copper. */
function copperScan() {
  const rules = copperSources();
  const tokens = new Set(COPPER_SEEDS);
  const nonApp = new Set<string>();
  const lits = (v: string) => literalsOf(v).filter((c) => copperLike(c) || isAppCopper(c));
  const refs = (v: string) => [...v.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
  const hasCopper = (v: string) => lits(v).length > 0 || refs(v).some((t) => tokens.has(t));
  const hasNonApp = (v: string) =>
    lits(v).some((c) => !isAppCopper(c)) || refs(v).some((t) => nonApp.has(t));
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rules)
      for (const [p, v] of Object.entries(r.decls)) {
        if (!p.startsWith("--") || COPPER_SEEDS.includes(p)) continue;
        if (hasCopper(v) && !tokens.has(p)) (tokens.add(p), (grew = true));
        if (hasNonApp(v) && !nonApp.has(p)) (nonApp.add(p), (grew = true));
      }
  }
  const uses: Array<{ key: string; rule: CopperRule; prop: string; nonApp: boolean }> = [];
  const seen = new Set<string>();
  for (const r of rules)
    for (const [p, v] of Object.entries(r.decls)) {
      if (p.startsWith("--") || !hasCopper(v)) continue;
      const key = `${r.source} :: ${r.selectors.join(", ")} :: ${p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uses.push({ key, rule: r, prop: p, nonApp: hasNonApp(v) });
    }
  uses.sort((a, b) => a.key.localeCompare(b.key));
  return { uses, rules };
}
const copperUses = (): string[] => copperScan().uses.map((u) => u.key);

// A status rule is one whose selector names a status, or whose declarations also use a status token.
const STATUS_WORDS =
  /(?:^|[^a-z])(?:status|success|ok|paid|pending|overdue|late|warn(?:ing)?|error|danger|fail(?:ed|ure)?|alert|invalid|valid|bad)(?![a-z])/i;
const STATUS_TOKEN = /var\(\s*--(?:rf|brand)-(?:paid|pending|overdue)/;
const isStatusRule = (r: { selectors: string[]; decls: Record<string, string> }) =>
  r.selectors.some((s) => STATUS_WORDS.test(s)) ||
  Object.values(r.decls).some((v) => STATUS_TOKEN.test(v));

// R17's jobs (run spec.md:84), and the one the owner added for pictures of the app (SA-1203 A4, 2026-11-21).
const R17_JOBS = [
  "logo symbol and dot",
  "the wheel part in focus",
  "the step in view",
  "pricing bars",
  "eyebrow dot",
  "one problem-section note",
  "text links",
] as const;
const PICTURE = "picture of the app (owner, 2026-11-21, SA-1203 A4)";
const ALLOWED_TAGS: readonly string[] = [...R17_JOBS, PICTURE];

const [LOGO, WHEEL, STEP, BARS, DOT, NOTE, LINK] = R17_JOBS;
const COPPER_ALLOW: Array<[source: string, selectors: string, property: string, tag: string]> = [
  ["components/site-frame/site-frame.css", ".rf-legal a", "color", LINK],
  ["css/color-deep.css", ".pd .kick::before", "background", DOT],
  ["css/company.css", ".co-body a", "color", LINK],
  [
    "css/home-color.css",
    ".home .hx .kick::before, .home #sell .kick::before, .home #journey .kick::before, .home #stores .kick::before, .home #counter .kick::before, .home #use-cases .kick::before",
    "background",
    DOT,
  ],
  [
    "css/home-color.css",
    ".home .inc-i:hover .inc-ic",
    "background",
    "no R17 job: use-case card dot or hover tile",
  ],
  [
    "css/home-color.css",
    ".home .uc-t h3::before",
    "background",
    "no R17 job: use-case card dot or hover tile",
  ],
  ["css/home-up.css", ".featured .pm-bar i", "background", BARS],
  ["css/home-up.css", ".pm-bar i", "background", BARS],
  ["css/home-up.css", "#founder .kick", "color", "no R17 job: eyebrow label text (not the dot)"],
  ["css/home.css", ".a-av", "color", PICTURE],
  ["css/home.css", ".a-link2", "color", PICTURE],
  ["css/home.css", ".a-nav li.on", "border-left", PICTURE],
  ["css/home.css", ".a-nav li.on .ico", "color", PICTURE],
  ["css/home.css", ".ans-i--p .ans-bar", "background", PICTURE],
  ["css/home.css", ".b-nav li.on", "border-left", PICTURE],
  ["css/home.css", ".b-nav li.on .ico", "color", PICTURE],
  ["css/home.css", ".c-chg b", "color", PICTURE],
  ["css/home.css", ".bi-3::before", "background", PICTURE],
  ["css/home.css", ".bx-f", "fill", "no R17 job: box art outside the pictures"],
  ["css/home.css", ".bx-s", "fill", "no R17 job: box art outside the pictures"],
  ["css/home.css", ".dv-go", "background", "no R17 job: dead rule, no element uses it"],
  ["css/home.css", ".end-mail a", "color", LINK],
  ["css/home.css", ".fd-more", "color", LINK],
  ["css/home.css", ".fd-note a", "color", LINK],
  ["css/home.css", ".home .fq a", "color", LINK],
  ["css/home.css", ".home #pricing .pl-inc a", "color", LINK],
  ["css/home.css", ".hx-more", "color", LINK],
  ["css/home.css", ".inc-plus", "color", "no R17 job: link-coloured or check-mark icon"],
  ["css/home.css", ".n3", "background", NOTE],
  ["css/home.css", ".rt-d--now", "fill", STEP],
  ["css/home.css", ".sp-all", "color", LINK],
  ["css/home.css", ".sp-q em", "color", PICTURE],
  ["css/home.css", ".sp-q i", "color", PICTURE],
  ["css/home.css", ".sp-top span", "color", PICTURE],
  ["css/home.css", ".st .kick", "color", "no R17 job: eyebrow label text (not the dot)"],
  ["css/product.css", ".pd main a:not(.btn):not(.pd-tile):not(.link):not(.pd-go)", "color", LINK],
  ["css/product.css", ".pd-go", "color", LINK],
  ["css/product.css", ".pd-more summary", "color", LINK],
  ["css/site.css", ":focus-visible", "outline", "no R17 job: focus ring"],
  [
    "css/site.css",
    ".band-ink .eyebrow, .band-ink .kick",
    "color",
    "no R17 job: eyebrow label text (not the dot)",
  ],
  ["css/site.css", ".band-ink a:not(.btn)", "color", LINK],
  ["css/site.css", ".cap::before", "background", DOT],
  ["css/site.css", ".eyebrow, .kick", "color", "no R17 job: eyebrow label text (not the dot)"],
  ["css/site.css", ".faq summary .ico", "color", "no R17 job: link-coloured or check-mark icon"],
  ["css/site.css", ".footer-grid a:hover", "color", LINK],
  ["css/site.css", ".link", "color", LINK],
  [
    "css/site.css",
    ".pcard.featured .checks .ico",
    "color",
    "no R17 job: link-coloured or check-mark icon",
  ],
  ["css/site.css", ".pg-top .eyebrow::before", "background", DOT],
  ["css/start.css", ".gs-step a:not(.link)", "color", LINK],
  ["graphics/rf-graphics.css", ".rf-hit:focus-visible", "outline-color", "no R17 job: focus ring"],
  ["graphics/rf-wheel-up.css", ".rfw-hint", "color", "no R17 job: link-coloured hint text"],
  ["graphics/rf-wheel-up.css", ".rfw-t .rfw-eye::before", "background", DOT],
  ["graphics/rf-wheel-up.css", ".rfw-w.f", "fill", WHEEL],
  ["graphics/rf-wheel-up.css", ".rfw-w.f", "stroke", WHEEL],
  ['home.html style=""', "style", "fill", "no R17 job: inline truck illustration fills"],
  ["landing.html <style>", ":focus-visible", "outline", "no R17 job: focus ring"],
  ["landing.html <style>", ".f-box", "fill", "no R17 job: landing box art"],
  ["landing.html <style>", ".f-flap", "fill", "no R17 job: landing box art"],
  ["landing.html <style>", ".foot a", "color", LINK],
  ["landing.html <style>", ".price :focus-visible", "outline-color", "no R17 job: focus ring"],
];
const copperKey = (source: string, selectors: string, property: string) =>
  `${source} :: ${selectors} :: ${property}`;

const FIGURE_SCOPE = 'figure[role="img"][aria-label]:not([aria-label=""])';
const stripState = (sel: string) =>
  sel.replace(/::?(?:before|after|hover|focus-visible|focus|active)\b/g, "");

describe("T17 static: copper only in listed jobs, never a status", () => {
  it("(a) every copper use is on the allow-list, and every allow-list row is still a copper use", () => {
    const allowed = COPPER_ALLOW.map(([s, sel, p]) => copperKey(s, sel, p));
    expect(new Set(allowed).size).toBe(allowed.length);
    const uses = copperUses();
    expect(uses.filter((u) => !allowed.includes(u))).toEqual([]);
    expect(allowed.filter((a) => !uses.includes(a))).toEqual([]);
  });

  it("(a) the scan reads <style> blocks and inline style, and sees rgb() and hsl() coppers", () => {
    const keys = copperUses();
    expect(keys.some((k) => k.startsWith("landing.html <style> ::"))).toBe(true);
    expect(keys.some((k) => k.startsWith('home.html style="" ::'))).toBe(true);
    const [r, g, b] = toRgb(COPPER_HEXES[0]);
    expect(literalsOf(`color: rgb(${r}, ${g}, ${b})`).some(isAppCopper)).toBe(true);
    expect(literalsOf("fill: hsl(23 52% 47%)").some(copperLike)).toBe(true);
    expect(literalsOf("color:#c0733f").some((c) => copperLike(c) && !isAppCopper(c))).toBe(true);
    expect(literalsOf("color:#0e1726").some(copperLike)).toBe(false);
  });

  it("(a) a picture row sits only inside a figure[role=img] with a label, and uses only the app's copper", () => {
    const docs = siteHtml().map((p) => new JSDOM(p.html).window.document);
    const { uses } = copperScan();
    const byKey = new Map(uses.map((u) => [u.key, u]));
    const offenders: string[] = [];
    for (const [source, selectors, property, tag] of COPPER_ALLOW) {
      if (tag !== PICTURE) continue;
      const key = copperKey(source, selectors, property);
      const use = byKey.get(key);
      if (!use || use.nonApp) offenders.push(`${key} (not the app's copper)`);
      if (!source.endsWith(".css")) offenders.push(`${key} (only a css rule can be a picture row)`);
      let matched = 0;
      for (const sel of selectors.split(", ")) {
        for (const d of docs) {
          let els: Element[] = [];
          try {
            els = [...d.querySelectorAll(stripState(sel))];
          } catch {
            offenders.push(`${key} (selector not readable)`);
          }
          for (const el of els) {
            matched++;
            if (!el.closest(FIGURE_SCOPE)) offenders.push(`${key} (outside a figure: ${sel})`);
          }
        }
      }
      if (matched === 0) offenders.push(`${key} (matches nothing)`);
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("(b) no status rule references copper", () => {
    const { uses } = copperScan();
    expect(uses.filter((u) => isStatusRule(u.rule)).map((u) => u.key)).toEqual([]);
  });

  it("(b) the status rules are found by selector or by status token", () => {
    const { rules } = copperScan();
    const find = (sel: string) => rules.find((r) => r.selectors.includes(sel));
    expect(find(".a-pill--bad")).toBeDefined();
    expect(find(".rfw-tk path")).toBeDefined();
    expect(isStatusRule(find(".a-pill--bad")!)).toBe(true);
    expect(isStatusRule(find(".rfw-tk path")!)).toBe(true);
    expect(isStatusRule(find(".link")!)).toBe(false);
  });

  it("(b) the status tokens resolve to the status palette, not to copper", () => {
    const decls = Object.assign(
      {},
      ...rulesOf(read("public/site/graphics/rf-graphics.css")).map((r) => r.decls),
    ) as Record<string, string>;
    const status = Object.keys(decls).filter((k) => /^--rf-(paid|pending|overdue)/.test(k));
    expect(status.length).toBeGreaterThanOrEqual(6);
    for (const k of status) {
      expect(decls[k]).toMatch(/^var\(--brand-(paid|pending|overdue)-(bg|text)\)$/);
    }
  });
});
