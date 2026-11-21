/**
 * @jest-environment node
 */
// Lane 2.4: the landing page (public/site/landing.html) on the brand seam and in the new look.
//   T14c  its inline token block is the block of rf-graphics.css
//   T35   no brand string, typed mark or typed colour in the file itself (the real predicate)
//   T35d  colour only through var(--rf-*) / var(--brand-*) in its style and its art
//   T18a  flat: no gradient, blur, glow or shadow but the one-pixel ring
//   T15   bands are white, bone or ink; ink buttons; status and copper only in their jobs
//   font  swap + a metric-matched fallback face + one preload (spec delta rev 4, item 6)
//   T37   no sentence ends with the name; the title is at most 60 characters
//   T12   every link and id the page had is still there (e2e/helpers/site-parity.baseline.json)
// The file is read raw for the scans and through readServedSitePage() for what a visitor gets.
import * as fs from "fs";
import * as path from "path";
import { BRAND, footerLine, loadBrand } from "@routeflow/types/brand";
import { readServedSitePage } from "@/lib/read-site-page";
import {
  CURRENT_BRAND,
  EXEMPT,
  brandLiteral,
  isFileExempt,
} from "@/lib/test-support/site-brand-exemptions";

const WEB = path.resolve(__dirname, "../..");
const LANDING = "public/site/landing.html";
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");

const raw = read(LANDING);
const served = (brand = loadBrand()) =>
  readServedSitePage("landing", { brand, websiteId: undefined });

const BLOCK = /\/\*tokens:start\*\/([\s\S]*?)\/\*tokens:end\*\//;
const stripCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
/** Whitespace-insensitive form of a css text, comments dropped. */
const norm = (css: string) =>
  stripCss(css)
    .replace(/\s+/g, " ")
    .replace(/\s*([{};:,])\s*/g, "$1")
    .trim();

const styles = (html: string) =>
  [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] as string).join("\n");
/** The page's own css with the shared token block taken out (the block is pinned by T14c). */
const ownCss = stripCss(styles(raw).replace(BLOCK, ""));
/** The html with the token block taken out and the one head colour (theme-color) set aside. */
const body = raw.replace(BLOCK, "").replace(/<meta name="theme-color"[^>]*>/, "");

interface Rule {
  selectors: string[];
  decls: Record<string, string>;
}
function rulesOf(css: string): Rule[] {
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
      const inner = text.slice(open + 1, j - 1);
      if (head.startsWith("@media") || head.startsWith("@supports")) walk(inner);
      else if (!head.startsWith("@")) {
        const decls: Record<string, string> = {};
        for (const d of inner.split(";")) {
          const k = d.indexOf(":");
          if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
        }
        out.push({ selectors: head.split(",").map((s) => s.trim()), decls });
      }
      i = j;
    }
  };
  walk(css);
  return out;
}
const RULES = rulesOf(ownCss);

describe("exemption", () => {
  it("landing.html has no row in the shared exemption table", () => {
    expect(EXEMPT.filter((e) => e.path === LANDING)).toEqual([]);
    expect(isFileExempt(LANDING)).toBe(false);
  });
});

describe("T14c: the inline token block is the block of rf-graphics.css", () => {
  const fromCss = read("public/site/graphics/rf-graphics.css").match(BLOCK)?.[1];
  const fromPage = raw.match(BLOCK)?.[1];

  it("has the block in both files (a missing marker cannot pass)", () => {
    expect(fromCss?.length).toBeGreaterThan(500);
    expect(fromPage?.length).toBeGreaterThan(500);
    expect(raw.match(/\/\*tokens:start\*\//g)).toHaveLength(1);
    expect(raw.match(/\/\*tokens:end\*\//g)).toHaveLength(1);
  });

  it("is the same declarations, whitespace and comments aside", () => {
    expect(norm(fromPage as string)).toBe(norm(fromCss as string));
  });
});

describe("T35: nothing that names the brand is typed in the file (the real predicate)", () => {
  const ALLOWED = ["RouteFlowShell", "routeflow-v4", "/brand/routeflow-mark"];
  const RF_PREFIX = /\brf-[a-z0-9-]+/gi;
  const TYPED_MARK = /M0 96V34a18|M66 2l14 14l-14 14|M26 96V52a8/;
  const HEX_IN_ATTR = /\b(?:style|fill|stroke)="[^"]*#[0-9a-fA-F]{3,8}\b/g;

  it("reads a real file", () => {
    expect(raw.length).toBeGreaterThan(5000);
  });

  it("has no brand literal, comments included", () => {
    let t = raw.replace(RF_PREFIX, "");
    for (const id of ALLOWED) t = t.split(id).join("");
    expect(t.match(brandLiteral()) ?? []).toEqual([]);
  });

  it("has no typed mark path and no hex in a style, fill or stroke attribute", () => {
    expect(TYPED_MARK.test(raw)).toBe(false);
    expect(raw.match(HEX_IN_ATTR) ?? []).toEqual([]);
  });

  it("names the brand only through tokens", () => {
    const tokens = new Set([...raw.matchAll(/\{\{brand:([^{}]*)\}\}/g)].map((m) => m[1]));
    for (const key of ["name", "origin", "email", "logo.onLight", "icon.favicon", "shareLine"]) {
      expect(tokens.has(key)).toBe(true);
    }
    expect(tokens.has("titleSeparator")).toBe(true);
  });
});

describe("T45 (landing alone): a fixture brand shows nothing of the real one", () => {
  const FIXTURE = loadBrand();
  const fx = {
    ...FIXTURE,
    name: "FIXTURE.TEST",
    origin: "https://www.fixture-host.example",
    email: "writeto@fixture-host.example",
    shareLine: "A fixture line.",
    titleSeparator: " :: ",
    logo: { ...FIXTURE.logo, onLight: "/fx/logo-light.svg" },
    icon: { ...FIXTURE.icon, favicon: "/fx/tab-icon.png" },
  };
  const html = served(fx);

  it("has none of the current brand and none of the planned name", () => {
    // SA-1203 A1: the one footer line names the previous name (the current brand here); remove it exactly
    const footer = footerLine(2026, fx)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
    expect(html.split(footer)).toHaveLength(2);
    expect(html.replace(footer, "")).not.toMatch(CURRENT_BRAND);
    expect(html).not.toMatch(/rovio/i);
  });

  it("takes name, host, mailbox and logo paths from the brand", () => {
    expect(html).toContain(
      "<title>FIXTURE.TEST :: Software for wholesalers and distributors</title>",
    );
    expect(html).toContain(`<link rel="canonical" href="${fx.origin}/landing">`);
    expect(html).toContain(`<meta property="og:site_name" content="FIXTURE.TEST">`);
    expect(html).toContain(`<link rel="icon" href="/fx/tab-icon.png"`);
    expect(html).toContain(`<img src="/fx/logo-light.svg"`);
    expect(html).toContain(`mailto:${fx.email}`);
    expect(html).toContain("© 2026 FIXTURE.TEST");
    expect(html).toContain(`content="FIXTURE.TEST. A fixture line."`);
    expect(html).toContain(`href="${fx.origin}/landing"`);
    expect(html).toContain(`content="${fx.origin}/opengraph-image"`);
  });

  it("carries one brand-tokens style from the palette", () => {
    expect(html.match(/<style id="brand-tokens">/g)).toHaveLength(1);
  });
});

describe("T35d: colour only through tokens", () => {
  const HEX_ANY = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;

  it("types no hex anywhere outside the token block (theme-color aside)", () => {
    expect(body.match(HEX_ANY) ?? []).toEqual([]);
  });

  it("types no rgb(), rgba(), hsl(), oklch() or color-mix() in its own css", () => {
    expect(ownCss.match(/\b(?:rgba?|hsla?|oklch|color-mix)\(/gi) ?? []).toEqual([]);
  });

  it("types no palette.json value in any form (3, 4, 6 or 8 digit)", () => {
    const palette = JSON.parse(
      fs.readFileSync(path.resolve(WEB, "../../packages/types/brand/palette.json"), "utf8"),
    ) as { color: Record<string, string> };
    const expand = (d: string) =>
      (d.length <= 4 ? [...d.slice(0, 3)].map((c) => c + c).join("") : d.slice(0, 6)).toLowerCase();
    const values = new Set(Object.values(palette.color).map((v) => v.slice(1).toLowerCase()));
    const found = (body.match(HEX_ANY) ?? []).map((h) => expand(h.slice(1)));
    expect(found.filter((v) => values.has(v))).toEqual([]);
  });

  it("names no colour keyword in a colour property", () => {
    const bad: string[] = [];
    for (const r of RULES) {
      for (const [prop, value] of Object.entries(r.decls)) {
        if (
          !/^(?:color|background(?:-color)?|fill|stroke|border(?:-[a-z]+)*|outline(?:-color)?)$/.test(
            prop,
          )
        )
          continue;
        if (
          /(?<![\w-])(?:white|black|red|blue|green|yellow|gray|grey|navy|orange|purple|pink)(?![\w-])/i.test(
            value,
          )
        ) {
          bad.push(`${r.selectors[0]} { ${prop}: ${value} }`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("points no rule or element at a retired token", () => {
    const RETIRED =
      /(?<![\w-])--(?:rf-brand-\d+|rf-on-navy|rf-link-on-navy|rf-tint|rf-ink-[23]|rf-sun(?:-soft)?|rf-coral(?:-soft)?|rf-mint(?:-soft)?|rf-ok|rf-sh-(?:card|sample|win)|navy(?:-d)?|sun|tint|ink(?:-[23])?)(?![\w-])/g;
    expect(body.match(RETIRED) ?? []).toEqual([]);
  });

  it("the art takes its fills and strokes from classes, not attributes", () => {
    const attrs = [...raw.matchAll(/\b(fill|stroke)="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);
    const odd = attrs.filter((a) => !/^(?:fill|stroke)=(?:none|currentColor)$/.test(a));
    expect(odd).toEqual([]);
  });
});

describe("T18a: flat, one ring", () => {
  it("has no gradient, blur, glow or shadow but the ring", () => {
    const offences: string[] = [];
    for (const word of [
      "gradient(",
      "drop-shadow",
      "blur(",
      "text-shadow",
      "<linearGradient",
      "<radialGradient",
      "feGaussianBlur",
      "backdrop-filter",
    ]) {
      if (body.includes(word)) offences.push(word);
    }
    for (const m of body.matchAll(/box-shadow\s*:\s*([^;}"]*)/g)) {
      const v = (m[1] as string).trim();
      if (v !== "var(--rf-ring)" && v !== "none") offences.push(`box-shadow:${v}`);
    }
    expect(offences).toEqual([]);
  });
});

describe("T15 and T16: bands, buttons, links, status and copper", () => {
  const BAND = new Set([
    "var(--rf-white)",
    "var(--rf-soft)",
    "var(--rf-panel)",
    "var(--rf-btn)",
    "var(--rf-on-panel)",
    "var(--rf-on-panel-2)",
    "var(--rf-btn-press)",
    "none",
    "transparent",
  ]);

  it("every background is white, bone or ink (or a button, or none)", () => {
    const bad: string[] = [];
    for (const r of RULES) {
      for (const prop of ["background", "background-color"]) {
        const v = r.decls[prop];
        if (v !== undefined && !BAND.has(v)) bad.push(`${r.selectors[0]} { ${prop}: ${v} }`);
      }
    }
    expect(bad).toEqual([]);
  });

  const decl = (selector: string, prop: string) =>
    RULES.filter((r) => r.selectors.includes(selector))
      .map((r) => r.decls[prop])
      .filter(Boolean);

  it("the primary button is ink with white text and presses darker", () => {
    expect(decl(".cta", "background")).toContain("var(--rf-btn)");
    expect(decl(".cta", "color")).toContain("var(--rf-btn-fg)");
    expect(decl(".cta:hover", "background")).toContain("var(--rf-btn-press)");
  });

  it("the page's own bands are white, bone and ink", () => {
    expect(decl("body", "background")).toContain("var(--rf-white)");
    expect(decl(".uses", "background")).toContain("var(--rf-soft)");
    expect(decl(".carry", "background")).toContain("var(--rf-panel)");
  });

  it("on the ink band the button is white", () => {
    expect(
      RULES.filter((r) => r.selectors.some((s) => /^\.price \.cta$|^\.carry \.cta$/.test(s))).map(
        (r) => r.decls.background,
      ),
    ).toContain("var(--rf-on-panel)");
  });

  it("copper is only in links, the focus ring and the carton art", () => {
    const COPPER =
      /var\(--rf-(?:copper(?:-light|-dark)?|accent(?:-on-panel)?|link(?:-on-panel)?|focus)\)/;
    const ALLOWED = new Set([
      ".foot a",
      ":focus-visible",
      ".price :focus-visible",
      ".f-box",
      ".f-flap",
    ]);
    const used = new Set<string>();
    for (const r of RULES) {
      if (Object.values(r.decls).some((v) => COPPER.test(v))) {
        for (const s of r.selectors) used.add(s);
      }
    }
    expect([...used].filter((s) => !ALLOWED.has(s))).toEqual([]);
    expect(used.has(".foot a")).toBe(true);
  });

  it("status colours are only on the Paid mark", () => {
    const used = new Set<string>();
    for (const r of RULES) {
      if (Object.values(r.decls).some((v) => /--rf-(?:paid|pending|overdue)/.test(v))) {
        for (const s of r.selectors) used.add(s);
      }
    }
    expect([...used].filter((s) => s !== ".f-paid")).toEqual([]);
    expect(used.has(".f-paid")).toBe(true);
  });
});

describe("review fixes: phone bar, art contrast, art tokens", () => {
  const last = (sel: string, prop: string) =>
    RULES.filter((r) => r.selectors.includes(sel) && r.decls[prop] !== undefined)
      .map((r) => r.decls[prop])
      .pop();

  it("on the phone the sticky bar sits flush on the footer (no ink strip below it)", () => {
    expect(last(".carry", "padding-bottom")).toBe("0");
  });

  it(".f-ink and .s-ink read the ink token, not the panel token", () => {
    expect(last(".f-ink", "fill")).toBe("var(--rf-ink)");
    expect(last(".s-ink", "stroke")).toBe("var(--rf-ink)");
  });

  it("the check badge on the phone card is not a Paid mark", () => {
    const phone = raw.split("<svg").find((x) => /places an order on a phone/.test(x)) as string;
    expect(phone).toBeDefined();
    expect(phone).not.toMatch(/f-paid/);
  });

  // Contrast of the art classes that carry meaning against the stage behind them (palette.json).
  const palette = (
    JSON.parse(
      fs.readFileSync(path.resolve(WEB, "../../packages/types/brand/palette.json"), "utf8"),
    ) as { color: Record<string, string> }
  ).color;
  const block = (raw.match(BLOCK)?.[1] as string) ?? "";
  const resolve = (token: string): string => {
    let t = token;
    for (let i = 0; i < 6; i++) {
      const m = /^var\((--[a-z0-9-]+)\)$/.exec(t);
      if (!m) break;
      const key = m[1] as string;
      if (key.startsWith("--brand-")) return palette[key.slice(8)] as string;
      t = new RegExp(`${key}:([^;}]+)`).exec(stripCss(block).replace(/\s+/g, ""))?.[1] ?? "";
    }
    throw new Error(`cannot resolve ${token}`);
  };
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
      number,
      number,
      number,
    ];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  const colourOf = (cls: string, prop: "fill" | "stroke") => {
    const v = last(`.${cls}`, prop);
    if (!v) throw new Error(`no ${prop} for .${cls}`);
    return resolve(v);
  };
  const STAGES = { white: "var(--rf-white)", soft: "var(--rf-soft)" } as const;
  const PAIRS: Array<["fill" | "stroke", string, keyof typeof STAGES]> = [
    ["fill", "f-steel", "soft"],
    ["fill", "f-steel", "white"],
    ["fill", "f-ink", "soft"],
    ["fill", "f-ink", "white"],
    ["fill", "f-box", "soft"],
    ["fill", "f-box", "white"],
    ["fill", "f-flap", "soft"],
    ["fill", "f-paid", "white"],
    ["fill", "f-paid", "soft"],
    ["stroke", "s-steel", "soft"],
    ["stroke", "s-steel", "white"],
    ["stroke", "s-ink", "soft"],
    ["stroke", "s-ink", "white"],
  ];
  it.each(PAIRS)("%s .%s on a %s stage is at least 3:1", (prop, cls, stage) => {
    expect(ratio(colourOf(cls, prop), resolve(STAGES[stage]))).toBeGreaterThanOrEqual(3);
  });

  it("the art uses no pale line colour for shapes (outlines and rows are steel or ink)", () => {
    expect(raw).not.toMatch(/class="[^"]*\b(?:f-line|s-line)\b/);
  });

  it("people have an ink outline on their face and hands, the same for both", () => {
    const heads =
      raw.match(/<rect[^>]*class="[^"]*f-paper s-ink[^"]*"[^>]*stroke-width="3"/g) ?? [];
    expect(heads.length).toBeGreaterThanOrEqual(3);
  });
});

describe("font: swap, a metric-matched fallback face, one preload", () => {
  const faces = [...ownCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] as string);
  const geist = faces.find((f) => /Geist-Variable/.test(f));
  const fallback = faces.find((f) => /font-family:\s*"Geist Fallback"/.test(f));

  it("the Geist face swaps", () => {
    expect(geist).toBeDefined();
    expect(geist).toMatch(/font-display:\s*swap/);
    expect(raw).not.toMatch(/font-display:\s*optional/);
  });

  it("the fallback face is Arial with the four metric overrides", () => {
    expect(fallback).toBeDefined();
    expect(fallback).toMatch(/src:\s*local\(\s*["']?Arial["']?\s*\)/);
    for (const prop of [
      "size-adjust",
      "ascent-override",
      "descent-override",
      "line-gap-override",
    ]) {
      expect(fallback).toMatch(new RegExp(`${prop}:\\s*\\d+(?:\\.\\d+)?%`));
    }
  });

  it("the overrides follow from Geist's hhea metrics and the average advance widths (constants, measured with fontTools)", () => {
    // Geist-Variable.woff2: unitsPerEm 1000, hhea 1005 / -295 / 0. Average advance (English letter
    // frequency weighted, capsize's method) / unitsPerEm: Geist 0.470632, Arial (2048 upm) 0.444475.
    const G = { upm: 1000, asc: 1005, desc: -295, gap: 0, avg: 0.470632 };
    const arialAvg = 0.444475;
    const pct = (prop: string) =>
      Number(new RegExp(`${prop}:\\s*([\\d.]+)%`).exec(fallback as string)?.[1]) / 100;
    const size = G.avg / arialAvg;
    expect(pct("size-adjust")).toBeCloseTo(size, 4);
    expect(pct("ascent-override")).toBeCloseTo(G.asc / G.upm / size, 4);
    expect(pct("descent-override")).toBeCloseTo(-G.desc / G.upm / size, 4);
    expect(pct("line-gap-override")).toBeCloseTo(G.gap / G.upm / size, 4);
  });

  it("every font stack puts the fallback face right after Geist", () => {
    const stacks = [...body.matchAll(/(['"])Geist\1\s*,\s*(['"]?)([^,;}'"]*)\2/g)].map((m) =>
      (m[3] as string).trim(),
    );
    expect(stacks.length).toBeGreaterThan(0);
    expect(stacks.filter((s) => s !== "Geist Fallback")).toEqual([]);
  });

  it("preloads the one Geist file", () => {
    const tags = [...raw.matchAll(/<link\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((t) => /rel="preload"/.test(t));
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatch(/href="\/site\/fonts\/Geist-Variable\.woff2"/);
    expect(tags[0]).toMatch(/as="font"/);
    expect(tags[0]).toMatch(/type="font\/woff2"/);
    expect(tags[0]).toMatch(/\scrossorigin/);
  });

  it("every img has a width and a height", () => {
    const bad = [...raw.matchAll(/<img\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((t) => !/\swidth="\d+"/.test(t) || !/\sheight="\d+"/.test(t));
    expect(bad).toEqual([]);
  });
});

describe("T37: no sentence ends with the name; the title is short", () => {
  const decode = (s: string) =>
    s
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  /** Visible text, plus content / aria-label / alt / title values; the og:image:alt label is not a sentence. */
  function readable(html: string): string {
    html = html.replace(/<meta property="og:image:alt"[^>]*>/g, "");
    const attrs = [...html.matchAll(/\b(?:content|aria-label|alt|title)="([^"]*)"/g)].map(
      (m) => m[1] as string,
    );
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, "");
    return decode([text, ...attrs].join("\n"));
  }
  const titleOf = (html: string) => decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "");
  const DOTTED = { ...loadBrand(), name: "FIXTURE.TEST" };

  it("no name followed by . ! or ?, real name and dotted fixture", () => {
    const real = readable(served());
    expect(real).toContain(BRAND.name);
    expect(real).not.toMatch(new RegExp(`${BRAND.name}\\s*[.!?]`));
    const fixture = readable(served(DOTTED));
    expect(fixture).toContain("FIXTURE.TEST");
    expect(fixture).not.toMatch(/FIXTURE\.TEST\s*[.!?]/);
  });

  it("the title is the name, the separator and the tagline, at most 60 characters", () => {
    expect(titleOf(served())).toBe(
      `${BRAND.name}${BRAND.titleSeparator}Software for wholesalers and distributors`,
    );
    expect(titleOf(served()).length).toBeLessThanOrEqual(60);
    expect(titleOf(served(DOTTED)).length).toBeLessThanOrEqual(60);
  });
});

describe("T12: nothing a visitor or the keyboard could reach is lost", () => {
  const baseline = JSON.parse(read("e2e/helpers/site-parity.baseline.json")) as {
    pages: Record<string, string[]>;
  };
  const html = served();
  const text = (s: string) =>
    decode(s.replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
  const decode = (s: string) =>
    s
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
  const rows = new Set<string>();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const href = /\shref="([^"]*)"/.exec(m[1] as string)?.[1];
    if (href === undefined) continue;
    const label = /\saria-label="([^"]*)"/.exec(m[1] as string)?.[1] ?? text(m[2] as string);
    rows.add(`a|${decode(href)}|${label}`);
  }
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) rows.add(`id|${m[1]}`);

  it.each(["desktop", "phone"])(
    "every baseline row of /landing (%s) is still on the page",
    (cls) => {
      const want = (baseline.pages[`/landing|${cls}`] ?? []).map((r) =>
        r.split("hello@routeflow.info").join(BRAND.email),
      );
      expect(want.length).toBeGreaterThan(5);
      expect(want.filter((r) => !rows.has(r))).toEqual([]);
    },
  );

  it("the three tracked trial buttons and the form-free page keep their data attributes", () => {
    const wheres = [...html.matchAll(/data-where="([^"]*)"/g)].map((m) => m[1]);
    expect(wheres).toEqual(["lp_hero", "lp_price", "lp_sticky"]);
    expect(html.match(/data-track="trial_start_click"/g)).toHaveLength(3);
  });
});
