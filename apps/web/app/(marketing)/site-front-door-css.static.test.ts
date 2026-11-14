/**
 * @jest-environment node
 */
// Lane 2.6b: the front door's own stylesheets (marketing.css, glass.css, glass-pages.css,
// glass-site.css). Area sweep (L-199): every rule in them was written under the class `.rf-marketing`
// or `.glass-page`; the wrapper that wore it left with the old marketing components, and the pages
// that are left (privacy, terms, sign-in, sign-up, 404, buyer login, verify email) are dressed by
// SiteFrame, the ready-made site's stylesheets and auth-shell.css. The consumer scan below is the
// structural proof; one test per registry id (B247, B248, B520, B550) holds the result.
import * as fs from "fs";
import * as path from "path";
import { readServedSitePage } from "@/lib/read-site-page";
import { STATIC_SITE_PAGE_NAMES } from "@/lib/static-site-pages";

const WEB = path.resolve(__dirname, "../..");
const REPO = path.resolve(WEB, "../..");
const FOUR = ["marketing.css", "glass.css", "glass-pages.css", "glass-site.css"].map(
  (f) => `app/(marketing)/${f}`,
);
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");
const stripCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// Everything that can put a class on a page: app code, shared components, libs, public files and the
// shared UI package. Tests, e2e specs and the test-support folder only read the page, they do not emit.
const SKIP_DIR = new Set(["node_modules", ".next", "e2e", "__tests__", "test-support", ".turbo"]);
// The ten ready-made pages are read through readServedSitePage (the route's own function), below.
const SOURCE = /\.(tsx?|jsx?|mjs)$/;
const TEST_FILE = /\.(test|spec)\.[jt]sx?$/;
const SCAN_ROOTS = [
  path.join(WEB, "app"),
  path.join(WEB, "components"),
  path.join(WEB, "lib"),
  path.join(WEB, "public"),
  path.join(REPO, "packages", "ui", "src"),
];
const stripCode = (text: string, file: string) =>
  file.endsWith(".html")
    ? text.replace(/<!--[\s\S]*?-->/g, "")
    : text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const sources: Array<{ file: string; text: string }> = [];
const walk = (dir: string) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (SOURCE.test(e.name) && !TEST_FILE.test(e.name)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      sources.push({ file: rel, text: stripCode(fs.readFileSync(full, "utf8"), full) });
    }
  }
};
SCAN_ROOTS.forEach(walk);
for (const page of STATIC_SITE_PAGE_NAMES) {
  const html = readServedSitePage(page, { websiteId: undefined });
  sources.push({ file: `apps/web/public/site/${page}.html`, text: stripCode(html, "page.html") });
}

/** Source files (comments stripped) whose text matches. */
const consumersOf = (re: RegExp): string[] =>
  sources.filter((s) => re.test(s.text)).map((s) => s.file);

describe("front-door stylesheets: the consumer scan", () => {
  it("scans the app, components, libs, public files and the ui package", () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(sources.some((s) => s.file === "apps/web/app/layout.tsx")).toBe(true);
    expect(sources.some((s) => s.file === "apps/web/components/site-frame/SiteFrame.tsx")).toBe(
      true,
    );
    expect(sources.some((s) => s.file === "apps/web/public/site/company.html")).toBe(true);
    expect(sources.some((s) => s.file.startsWith("packages/ui/src/"))).toBe(true);
  });

  it("nothing emits the rf-marketing class the stylesheets were scoped under", () => {
    expect(consumersOf(/rf-marketing/)).toEqual([]);
  });

  it("nothing emits the glass-page class glass-site.css was scoped under", () => {
    expect(consumersOf(/(?<![\w-])glass-page(?![\w-])/)).toEqual([]);
  });

  it("nothing builds either class name from parts", () => {
    expect(consumersOf(/["'`]rf-["'`]\s*\+|["'`]glass-["'`]\s*\+|\$\{[^}]*\}-marketing/)).toEqual(
      [],
    );
  });
});

describe("B247: the front door ships no token or utility layer of its own beside globals.css", () => {
  it("the four stylesheets hold no rule, no at-rule and no custom property", () => {
    for (const f of FOUR) {
      const css = stripCss(read(f)).trim();
      expect({ f, css: css.slice(0, 80) }).toEqual({ f, css: "" });
    }
  });

  it("no other stylesheet sits in app/(marketing)", () => {
    const here = fs
      .readdirSync(path.join(WEB, "app/(marketing)"))
      .filter((n) => n.endsWith(".css"))
      .map((n) => `app/(marketing)/${n}`)
      .sort();
    expect(here).toEqual([...FOUR].sort());
  });

  it("an imported stylesheet exists; a file that is not imported is deleted (the root layout owns the import)", () => {
    const layout = read("app/layout.tsx");
    for (const f of FOUR) {
      const name = path.basename(f);
      const imported = new RegExp(`import\\s+["'][^"']*${name.replace(".", "\\.")}["']`).test(
        layout,
      );
      if (imported) expect(fs.existsSync(path.join(WEB, f))).toBe(true);
      else expect({ f, exists: fs.existsSync(path.join(WEB, f)) }).toEqual({ f, exists: false });
    }
  });
});

describe("B248: no typed purple and no --plum token in the front door", () => {
  it("none of the purple values or the token appears in the four stylesheets", () => {
    const text = FOUR.map(read).join("\n");
    expect(text.match(/#7b49ab|#623691|#dcc1ef|#6d369e|#c7a2e1|#714a8b/gi) ?? []).toEqual([]);
    expect(text.match(/--plum/g) ?? []).toEqual([]);
  });

  it("no source reads the token", () => {
    expect(consumersOf(/--plum/)).toEqual([]);
  });
});

describe("B520: no scroll-reveal that starts at opacity 0", () => {
  it("the reveal rules are gone from the four stylesheets", () => {
    const text = FOUR.map(read).join("\n");
    expect(text.match(/editorial-reveal|reveal-pending/g) ?? []).toEqual([]);
  });

  it("the observer module is gone and nothing emits or imports the reveal names", () => {
    expect(fs.existsSync(path.join(WEB, "app/(marketing)/components/editorial-motion.tsx"))).toBe(
      false,
    );
    expect(consumersOf(/editorial-reveal|reveal-pending|editorial-motion/)).toEqual([]);
  });
});

describe("B550: no company-page grid that can overflow at 761-950px", () => {
  it("the grid selectors are gone from the four stylesheets", () => {
    const text = stripCss(FOUR.map(read).join("\n"));
    expect(text.match(/\.company-principles|\.feature-grid/g) ?? []).toEqual([]);
  });

  it("no page or component uses those classes (the company page is a ready-made page with its own css)", () => {
    expect(consumersOf(/company-principles|feature-grid/)).toEqual([]);
    const company = readServedSitePage("company", { websiteId: undefined });
    expect(company).not.toMatch(/company-principles|feature-grid/);
    expect(company).toContain("/site/css/company.css");
  });
});
