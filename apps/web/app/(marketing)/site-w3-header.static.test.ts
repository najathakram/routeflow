/**
 * @jest-environment node
 */
// Wave 3, header lane. The static half of the header rows (the browser half is e2e/93-site-w3-header.spec.ts):
// one observer owns the "header trial pill steps aside" class, the phone menu fits its Sign in and trial button
// in one screen, the plan cards share a row height, the top band's line, and no stylesheet reads a custom
// property nothing sets (SA-1186 K5). Every scan asserts it found its targets (L-202).
import * as fs from "fs";
import * as path from "path";

const WEB = path.resolve(__dirname, "../..");
const SITE = path.join(WEB, "public/site");
const read = (rel: string) => fs.readFileSync(path.join(SITE, rel), "utf8");

/** Custom properties a rule reads with no fallback and nothing declares. `declared` is every text that may set one. */
function undeclaredVarReads(
  readers: Record<string, string>,
  declared: string[],
): Array<{ file: string; prop: string }> {
  const set = new Set<string>();
  for (const text of declared) {
    for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:/gi)) set.add(m[1] as string);
    for (const m of text.matchAll(/setProperty\(\s*["'](--[a-z0-9-]+)/g)) set.add(m[1] as string);
  }
  const out: Array<{ file: string; prop: string }> = [];
  let reads = 0;
  for (const [file, text] of Object.entries(readers)) {
    for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/gi)) {
      reads++;
      if (m[2] === ",") continue; // has a fallback
      if (!set.has(m[1] as string)) out.push({ file, prop: m[1] as string });
    }
  }
  if (reads === 0) throw new Error("the sweep found no var() reads: it would pass on nothing");
  return out;
}

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });

describe("K5: no var() read names a property nothing sets", () => {
  const READERS = ["css/home.css", "css/home-up.css", "css/home-color.css"];
  const declaredTexts = () => {
    const files = walk(SITE).filter((f) => /\.(css|js|html)$/.test(f));
    expect(files.length).toBeGreaterThan(20);
    const palette = fs.readFileSync(
      path.resolve(WEB, "../../packages/types/brand/palette.json"),
      "utf8",
    );
    const keys = Object.keys((JSON.parse(palette) as { color: Record<string, string> }).color);
    return [
      ...files.map((f) => fs.readFileSync(f, "utf8")),
      keys.map((k) => `--brand-${k}:x;`).join(""),
      fs.readFileSync(path.join(WEB, "components/site-frame/site-frame.css"), "utf8"),
    ];
  };

  it("the checker names an unset property, accepts a fallback, an inline setter and a js setter", () => {
    const bad = { "a.css": ".uc-t h3::before{background:var(--pc)}" };
    expect(undeclaredVarReads(bad, [".x{color:red}"])).toEqual([{ file: "a.css", prop: "--pc" }]);
    expect(undeclaredVarReads({ "a.css": "a{b:var(--pc,#000)}" }, [""])).toEqual([]);
    expect(undeclaredVarReads(bad, ['<li style="--pc:#fff">'])).toEqual([]);
    expect(undeclaredVarReads(bad, ['el.style.setProperty("--pc", v)'])).toEqual([]);
    expect(() => undeclaredVarReads({ "a.css": "a{b:c}" }, [""])).toThrow(/no var\(\) reads/);
  });

  it("home.css, home-up.css and home-color.css read only properties the site sets", () => {
    const readers = Object.fromEntries(READERS.map((f) => [f, read(f)]));
    expect(undeclaredVarReads(readers, declaredTexts())).toEqual([]);
  });

  it("with the page's inline setters taken away, home-up.css reads nothing unset (the use-case dot is gone)", () => {
    // The tree after the home lane drops its inline --pc: the dot rule (this lane) must not be one of the readers.
    const noInline = declaredTexts().map((t) =>
      t.replace(/--pc:[^;"]*;?/g, "").replace(/--pi:[^;"]*;?/g, ""),
    );
    const readers = Object.fromEntries(READERS.map((f) => [f, read(f)]));
    const left = undeclaredVarReads(readers, noInline).filter((r) => r.file === "css/home-up.css");
    expect(left).toEqual([]);
  });

  it("the unset --pc read (the empty heading dot) is gone from home-up.css", () => {
    const css = read("css/home-up.css");
    expect(css).not.toMatch(/\.uc-t h3::before/);
    expect(css).not.toMatch(/\.uc-t h3\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.uc-t p\{/); // the sweep found the neighbouring rule: it read the right file
  });
});

describe("one observer owns the header trial pill", () => {
  const site = read("js/site.js");

  it("site.js toggles hero-btn-in, from the trial buttons outside the header and the phone menu", () => {
    expect(site.match(/toggle\("hero-btn-in"/g)).toHaveLength(1);
    expect(site).toMatch(/\.btn\[href\^="\/signup"\]/);
    expect(site).toMatch(/closest\("\.site-header, #mobile-menu/);
  });

  it("home-up.js no longer toggles it", () => {
    expect(read("js/home-up.js")).not.toContain("hero-btn-in");
  });

  it("the React header does not hard-code the class", () => {
    const tsx = fs.readFileSync(
      path.join(WEB, "components/site-frame/SiteFrameHeader.tsx"),
      "utf8",
    );
    expect(tsx).toContain("site-header");
    expect(tsx).not.toContain("hero-btn-in");
  });

  it("the rule set lives in site.css (every page), not in home-up.css", () => {
    const css = read("css/site.css");
    expect(css).toContain(".js .site-header.hero-btn-in .btn-sm{display:none}");
    expect(css).toContain(".js .site-header.hero-btn-in .nav-price{display:inline-flex}");
    expect(css).toContain(".js body.menu-open .site-header.hero-btn-in .nav-price{display:none}");
    expect(read("css/home-up.css")).not.toContain("hero-btn-in");
  });

  it("an open phone menu has one trial button: the header pill steps aside", () => {
    expect(read("css/site.css")).toMatch(/body\.menu-open \.site-header \.btn-sm\{display:none\}/);
  });
});

describe("F08: the open phone menu shows Sign in and the trial button in one screen", () => {
  const css = read("css/site.css");
  const num = (re: RegExp) => {
    const m = css.match(re);
    if (!m) throw new Error(`no match for ${re}`);
    return Number(m[1]);
  };

  it.each([
    ["company.html", 740],
    ["home.html", 740],
  ])("%s: the links, Sign in and the button fit in a %i px tall phone", (file, height) => {
    const html = read(file);
    const at = html.indexOf('id="mobile-menu"');
    const menu = html.slice(at, html.indexOf("</nav>", at));
    const links = (menu.match(/<a\b/g) ?? []).length; // every link, Sign in, and the trial button
    expect(links).toBeGreaterThan(10);
    const row = num(/\.mobile-menu a\{[^}]*min-height:(\d+)px/);
    const gap = num(/\.mobile-menu \.btn\{[^}]*margin-top:(\d+)px/);
    const padTop = num(/\.mobile-menu\{[^}]*padding:(\d+)px/);
    const top = num(/\.mobile-menu\{[^}]*inset:(\d+)px/);
    expect(row).toBeGreaterThanOrEqual(44);
    expect(top + padTop + links * row + gap).toBeLessThanOrEqual(height);
  });
});

describe("P01 and the band line", () => {
  const css = read("css/site.css");

  it("the plan cards of a row stretch to one height, with the leftover space above the list", () => {
    expect(css).toMatch(/\.pgrid\{[^}]*align-items:stretch/);
    expect(css).not.toMatch(/\.pgrid\{[^}]*align-items:start/);
    expect(css).toMatch(/\.pcard \.checks\{[^}]*margin-top:auto/);
    expect(css).toMatch(/\.pbtn\{[^}]*margin-top:0/);
  });

  it("band-line closes a band with the one-pixel line, next to the band roles", () => {
    expect(css).toContain(".band-line{border-bottom:1px solid var(--rf-line)}");
    expect(css.indexOf(".band-line{")).toBeGreaterThan(css.indexOf(".band-white{"));
  });
});

describe("the header stays put", () => {
  it("is sticky at the top with a fixed 68 px bar, and nothing in the stylesheet changes the bar's height", () => {
    const css = read("css/site.css");
    expect(css).toMatch(/\.site-header\{position:sticky;top:0;/);
    expect(css).toMatch(/\.nav\{[^}]*height:68px/);
    expect(css).not.toMatch(/\.site-header\.scrolled\{[^}]*(height|padding)/);
  });
});
