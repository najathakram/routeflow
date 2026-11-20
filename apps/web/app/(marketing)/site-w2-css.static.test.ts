/**
 * @jest-environment node
 */
// Lane 2.1b, the shared stylesheets (site, mobile, home, home-up): the matched fallback face for the font (T43 font
// rule), the three band roles, the flat header, the label pill that reads the same at every width (P13), the one
// no-break class (P15 CSS half), the plan-table header baseline (P14), and one focus-ring token that holds 3:1 on
// white, bone and ink without a list of selectors (D-4). Everything is read from the files at test time; a sweep that
// finds nothing throws.
import * as fs from "fs";
import * as path from "path";
import { readServedSitePage } from "@/lib/read-site-page";

const WEB = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const SITE = strip(read("public/site/css/site.css"));
const MOBILE = strip(read("public/site/css/mobile.css"));
/** palette.json, read at test time: no colour is typed in this file. */
const PALETTE = JSON.parse(
  fs.readFileSync(path.resolve(WEB, "../../packages/types/brand/palette.json"), "utf8"),
).color as Record<string, string>;

type Rule = { selectors: string[]; decls: Record<string, string> };
/** Top-level rules and the rules inside @media / @supports, with comments stripped. */
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
  walk(css);
  return out;
};
const rulesFor = (css: string, sel: string): Rule[] => {
  const hits = rulesOf(css).filter((r) => r.selectors.includes(sel));
  if (hits.length === 0) throw new Error(`no rule for ${sel}`);
  return hits;
};
const declOf = (css: string, sel: string, prop: string): string[] =>
  rulesFor(css, sel)
    .map((r) => r.decls[prop])
    .filter((v): v is string => v !== undefined);

const faceOf = (css: string, family: string): string => {
  const m = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].find((x) =>
    (x[1] as string).includes(`font-family:"${family}"`),
  );
  if (!m) throw new Error(`no @font-face for ${family}`);
  return (m[1] as string).replace(/\s+/g, "");
};

describe("font: a matched fallback face, so a swap shifts nothing", () => {
  const css = read("public/site/css/site.css");

  it("site.css has a Geist Fallback face over the local Arial", () => {
    const face = faceOf(css, "Geist Fallback");
    expect(face).toContain('src:local("Arial")');
  });

  it("its overrides are the ones the landing page carries", () => {
    const landing = faceOf(
      readServedSitePage("landing", { websiteId: undefined }),
      "Geist Fallback",
    );
    const pick = (face: string) =>
      ["size-adjust", "ascent-override", "descent-override", "line-gap-override"].map((p) => {
        const m = new RegExp(`${p}:([^;}]+)`).exec(face);
        if (!m) throw new Error(`no ${p}`);
        return `${p}:${m[1]}`;
      });
    expect(pick(faceOf(css, "Geist Fallback"))).toEqual(pick(landing));
  });

  it("the face is second in the body stack, after Geist", () => {
    const stack = declOf(SITE, "body", "font-family")[0] as string;
    expect(stack.startsWith('"Geist","Geist Fallback",')).toBe(true);
  });

  it("the shared font line of rf-graphics.css is the one the pin keeps", () => {
    expect(read("public/site/graphics/rf-graphics.css")).toContain(
      '--rf-font:"Geist","Geist Fallback",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;',
    );
  });
});

describe("band roles: white, bone and ink, as tokens, in site.css only", () => {
  const ROLES: Array<[string, string, string]> = [
    [".band-white", "var(--rf-white)", "var(--rf-text)"],
    [".band-bone", "var(--rf-soft)", "var(--rf-text)"],
    [".band-ink", "var(--rf-panel)", "var(--rf-on-panel)"],
  ];

  it.each(ROLES)("%s paints %s with %s text", (sel, bg, fg) => {
    const rules = rulesFor(SITE, sel);
    expect(rules.map((r) => r.decls.background)).toContain(bg);
    expect(rules.map((r) => r.decls.color)).toContain(fg);
    for (const r of rules) {
      for (const v of Object.values(r.decls)) expect(v).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });

  it("mobile.css paints no band: no background on a section, the pricing top, the home pricing or a card", () => {
    const rules = rulesOf(MOBILE);
    expect(rules.length).toBeGreaterThan(10);
    for (const r of rules) {
      for (const sel of r.selectors) {
        if (/\.section|\.pg-top|#pricing|\.risk|\.pl-wrap/.test(sel)) {
          expect({ sel, bg: r.decls.background, image: r.decls["background-image"] }).toEqual({
            sel,
            bg: undefined,
            image: undefined,
          });
        }
      }
    }
    expect(MOBILE).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(MOBILE).not.toContain("gradient(");
  });
});

describe("the header is flat: a token background on a one-pixel line, no blur", () => {
  it("the header rule has a token background, the ring, no backdrop filter", () => {
    const rules = rulesFor(SITE, ".site-header");
    const base = rules.find((r) => r.decls.position === "sticky");
    if (!base) throw new Error("no sticky .site-header rule");
    expect(base.decls.background).toBe("var(--rf-white)");
    expect(base.decls["box-shadow"]).toBe("var(--rf-ring)");
    expect(base.decls["backdrop-filter"]).toBeUndefined();
    expect(SITE).not.toContain("backdrop-filter");
  });

  it("an ink header takes the panel token", () => {
    expect(declOf(SITE, ".site-header.on-dark", "background")).toEqual(["var(--rf-panel)"]);
  });
});

describe("P13: the pricing label is one rule in site.css", () => {
  it("is a pill with a copper dot in site.css and is gone from mobile.css", () => {
    const d = rulesFor(SITE, ".pg-top .eyebrow")[0]!.decls;
    expect(d.display).toBe("inline-flex");
    expect(d["border-radius"]).toBe("999px");
    expect(d.background).toBe("var(--rf-soft)");
    expect(declOf(SITE, ".pg-top .eyebrow::before", "background")).toEqual(["var(--rf-accent)"]);
    expect(MOBILE).not.toContain(".pg-top .eyebrow");
  });
});

describe("P15 (CSS half): .nb holds a phrase on one line at every width", () => {
  it("site.css defines it, mobile.css does not repeat it", () => {
    expect(declOf(SITE, ".nb", "white-space")).toEqual(["nowrap"]);
    expect(MOBILE).not.toContain(".nb{");
  });
});

describe("P01: a plan card is as tall as its own content, so no empty fill sits above its button", () => {
  it("the plan grid aligns its cards to the start", () => {
    expect(declOf(SITE, ".pgrid", "align-items")).toEqual(["start"]);
  });
});

describe("P14: the plan-table header cells share a baseline", () => {
  it(".pl thead th aligns to the bottom", () => {
    expect(declOf(SITE, ".pl thead th", "vertical-align")).toEqual(["bottom"]);
  });
});

describe("D-4: one focus token, set by the band, never a list of selectors", () => {
  const CSS_FILES = (): string[] => {
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
  const graphics = strip(read("public/site/graphics/rf-graphics.css"));

  it("the global ring reads --rf-focus, and the root sets it to the accent token", () => {
    expect(declOf(SITE, ":focus-visible", "outline")).toEqual(["3px solid var(--rf-focus)"]);
    expect(declOf(graphics, ":root", "--rf-focus")).toEqual(["var(--rf-accent)"]);
  });

  it("the retired --ring-c is named nowhere in the site css", () => {
    const files = CSS_FILES();
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      expect({ f, hit: read(f).includes("--ring-c") }).toEqual({ f, hit: false });
    }
  });

  it("no rule recolours the ring by naming a panel under :focus-visible", () => {
    const sels = rulesOf(SITE).flatMap((r) => r.selectors);
    expect(sels.filter((s) => s.includes(":focus-visible"))).toEqual([":focus-visible"]);
  });

  it("outside :root only the two dark panels set --rf-focus, to the on-panel accent", () => {
    const setters: Array<{ sel: string; value: string }> = [];
    for (const f of CSS_FILES()) {
      for (const r of rulesOf(strip(read(f)))) {
        if (r.selectors.includes(":root")) continue;
        const v = r.decls["--rf-focus"];
        if (v !== undefined) for (const sel of r.selectors) setters.push({ sel, value: v });
      }
    }
    expect(setters.map((x) => x.sel).sort()).toEqual([".end", ".pb"]);
    for (const x of setters) expect(x.value).toBe("var(--rf-accent-on-panel)");
  });

  it("the roles hold 3:1: the accent on white and bone, the on-panel accent on the panel", () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
    };
    const ratio = (x: string, y: string) => {
      const [hi, lo] = [lum(x), lum(y)].sort((m, n) => n - m);
      return ((hi as number) + 0.05) / ((lo as number) + 0.05);
    };
    expect(ratio(PALETTE.copper as string, PALETTE.white as string)).toBeGreaterThanOrEqual(3);
    expect(ratio(PALETTE.copper as string, PALETTE.bone as string)).toBeGreaterThanOrEqual(3);
    expect(ratio(PALETTE["copper-light"] as string, PALETTE.ink as string)).toBeGreaterThanOrEqual(
      3,
    );
  });
});

describe("T21: the box art tokens read the palette", () => {
  const css = strip(read("public/site/graphics/rf-graphics.css"));
  const decls = new Map<string, string>();
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
    if (!decls.has(m[1] as string)) decls.set(m[1] as string, (m[2] as string).trim());
  }
  /** Follow var(--x) links to a typed hex, or to a palette key through --brand-<key>. */
  const resolve = (name: string, seen = new Set<string>()): string => {
    if (seen.has(name)) throw new Error(`cycle at ${name}`);
    seen.add(name);
    const brand = /^--brand-(.+)$/.exec(name);
    if (brand) return (PALETTE[brand[1] as string] ?? "").toUpperCase();
    const v = decls.get(name);
    if (v === undefined) throw new Error(`${name} is not declared`);
    const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
    if (ref) return resolve(ref[1] as string, seen);
    if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
    throw new Error(`${name}: ${v} is neither a var nor a six digit hex`);
  };
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
  };

  it("the front is copper light and the side is copper, read from palette.json", () => {
    expect(resolve("--rf-box-front")).toBe((PALETTE["copper-light"] as string).toUpperCase());
    expect(resolve("--rf-box-side")).toBe((PALETTE.copper as string).toUpperCase());
  });

  it("the top is a lighter warm tint that is no palette value", () => {
    const top = resolve("--rf-box-top");
    expect(Object.values(PALETTE).map((v) => v.toUpperCase())).not.toContain(top);
    expect(lum(top)).toBeGreaterThan(lum(resolve("--rf-box-front")));
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(top.slice(i, i + 2), 16));
    expect((r as number) > (g as number) && (g as number) > (b as number)).toBe(true);
  });

  it("no art role is built from a retired name, and each one is declared", () => {
    const retired =
      /--rf-(?:brand-\d+|on-navy|link-on-navy|tint|ink-[23]|sun|coral|mint|ok|sh-(?:card|sample|win))(?![\w-])/;
    const roles = ["--rf-road", "--rf-pill-bg", "--rf-pill-fg", "--rf-cargo", "--rf-cargo-mark"];
    for (const n of [...roles, "--rf-disc-a", "--rf-disc-b", "--rf-disc-c"]) {
      expect(decls.has(n)).toBe(true);
      expect(retired.test(decls.get(n) as string)).toBe(false);
    }
  });
});

describe("font: the frame pages and the scene already have the fallback face", () => {
  it("every page that links rf-graphics.css also links site.css, which holds both faces", () => {
    const dir = path.join(WEB, "public/site");
    const pages = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
    const text = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
    const linking = pages.filter((f) => text(f).includes("graphics/rf-graphics.css"));
    expect(linking.length).toBeGreaterThan(5);
    for (const f of linking) {
      expect({ f, site: text(f).includes("/site/css/site.css") }).toEqual({ f, site: true });
    }
    expect(read("components/site-frame/SiteFrame.tsx")).toContain('href="/site/css/site.css"');
    const css = read("public/site/css/site.css");
    expect(() => faceOf(css, "Geist")).not.toThrow();
    expect(() => faceOf(css, "Geist Fallback")).not.toThrow();
  });
});
