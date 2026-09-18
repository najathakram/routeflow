import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// R-MKT T5, T6, T7 — static/textual scans of the repo (no rendering). Every
// path below is resolved from this file's own location so the test is
// independent of the process cwd.
const WEB_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(WEB_ROOT, "../..");

// ---------------------------------------------------------------------------
// T5 — dead-weight sweep: old logo/favicon references gone, retired files
// gone, new brand/marketing/font assets present and small, banned deps and
// banned Tailwind-4 syntax gone.
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".json", ".md", ".mdx"]);
const IGNORE_DIRS = new Set(["node_modules", ".next", ".turbo", "dist", "coverage", ".git"]);

function walkTextFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTextFiles(full, out);
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function findSourceReferences(
  dirs: string[],
  needle: string,
): Array<{ file: string; line: number }> {
  const hits: Array<{ file: string; line: number }> = [];
  for (const dir of dirs) {
    for (const file of walkTextFiles(dir)) {
      // This file itself legitimately names every banned string as a
      // string literal for the scan below — never flag itself.
      if (file === __filename) continue;
      const text = fs.readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (line.includes(needle)) hits.push({ file: path.relative(REPO_ROOT, file), line: i + 1 });
      });
    }
  }
  return hits;
}

const SCAN_DIRS = [
  path.join(WEB_ROOT, "app"),
  path.join(WEB_ROOT, "components"),
  path.join(WEB_ROOT, "public"),
  path.join(REPO_ROOT, "packages", "ui", "src", "web"),
];

const BANNED_LOGO_STRINGS = ["/logo.svg", "logo-buyer", "logo-seller", "favicon.png"];

// Already absent on the untouched tree (0 hits), so this is a standing guard
// against a regression, not a red row. It carries the MKT-PIN token instead of
// R-MKT so the red gate (`jest -t "R-MKT"`) selects only rows that are red
// before the port lands; it still runs in the full `npx jest` suite.
const PINNED_ABSENT_LOGO_STRINGS = ["favicon.svg"];

describe("dead logo/favicon references — R-MKT T5", () => {
  it.each(BANNED_LOGO_STRINGS)(
    'zero source references to "%s" under app/, components/, public/, packages/ui/src/web (R-MKT T5)',
    (needle) => {
      const hits = findSourceReferences(SCAN_DIRS, needle);
      expect(hits).toEqual([]);
    },
  );
});

describe("logo/favicon references that are already absent — MKT-PIN T5", () => {
  it.each(PINNED_ABSENT_LOGO_STRINGS)(
    'zero source references to "%s" under app/, components/, public/, packages/ui/src/web (MKT-PIN T5)',
    (needle) => {
      const hits = findSourceReferences(SCAN_DIRS, needle);
      expect(hits).toEqual([]);
    },
  );
});

const RETIRED_FILES = [
  "public/logo.svg",
  "public/logo-buyer.svg",
  "public/logo-buyer.png",
  "public/logo-seller.png",
  "public/favicon.svg",
  "public/favicon.png",
  "app/(marketing)/components/logo.tsx",
  "app/(marketing)/components/use-side.ts",
  "app/(marketing)/product-video.tsx",
  "app/contact/page.tsx",
];

describe("retired marketing files are gone — R-MKT T5", () => {
  it.each(RETIRED_FILES)("%s no longer exists (R-MKT T5)", (relPath) => {
    expect(fs.existsSync(path.join(WEB_ROOT, relPath))).toBe(false);
  });
});

const NEW_ASSET_FILES = [
  "public/brand/routeflow-mark-64.png",
  "public/brand/routeflow-mark-180.png",
  "public/brand/routeflow-mark-192.png",
  "public/brand/routeflow-mark-512.png",
  "public/marketing/warehouse.webp",
  "public/marketing/retailer-technology.webp",
  "public/marketing/stock-cutout-v3.webp",
  "fonts/Geist-Variable.woff2",
  "fonts/GeistMono-Variable.woff2",
];
const MAX_IMAGE_BYTES = 150 * 1024;

describe("new brand/marketing/font assets ship — R-MKT T5", () => {
  it.each(NEW_ASSET_FILES)("%s exists (R-MKT T5)", (relPath) => {
    expect(fs.existsSync(path.join(WEB_ROOT, relPath))).toBe(true);
  });
});

// The size ceiling cannot fail on its OWN oracle until the assets exist — an
// absent file makes every row fail on the sibling existence check instead. It
// is therefore a ceiling to hold once the assets land, not evidence today, so
// it carries the MKT-PIN token and is out of the red gate.
describe("new brand/marketing assets stay small — MKT-PIN T5", () => {
  it.each(NEW_ASSET_FILES.filter((f) => /\.(png|webp|jpe?g)$/i.test(f)))(
    "%s is <= 150 KB (MKT-PIN T5)",
    (relPath) => {
      const full = path.join(WEB_ROOT, relPath);
      if (!fs.existsSync(full)) {
        // Already reported as missing by the existence test above — avoid a
        // second, redundant failure reason here.
        expect(fs.existsSync(full)).toBe(true);
        return;
      }
      expect(fs.statSync(full).size).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    },
  );
});

// `recharts` and `react-day-picker` are load-bearing dashboard dependencies
// (apps/web/components/ReportChart.tsx, DateRangePicker.tsx, and eight
// operator/platform-admin/buyer-portal pages) — out of this port's scope and
// NOT to be removed from apps/web/package.json. R15's actual requirement is
// that the marketing port doesn't drag either of them (or the redesign's
// other dependencies) into the marketing tree, so the check below is scoped
// to imports under app/(marketing)/** and components/brand/** rather than to
// the whole-package dependency list.
const BANNED_MARKETING_IMPORTS = ["recharts", "react-day-picker"];
// Never present in apps/web/package.json — standing guards against the port
// dragging the redesign's dependency set in. MKT-PIN, so out of the red gate.
const PINNED_ABSENT_DEPENDENCIES = [
  "three",
  "embla-carousel-react",
  "cmdk",
  "@base-ui/react",
  "tw-animate-css",
];

function webPackageDependencyNames(): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

const MARKETING_IMPORT_SCAN_DIRS = [
  path.join(WEB_ROOT, "app", "(marketing)"),
  path.join(WEB_ROOT, "components", "brand"),
];

describe("marketing tree does not import dead dependencies — R-MKT T5", () => {
  it.each(BANNED_MARKETING_IMPORTS)(
    'no import/require of "%s" under app/(marketing)/**, components/brand/** (R-MKT T5)',
    (dep) => {
      const hits = findSourceReferences(MARKETING_IMPORT_SCAN_DIRS, dep);
      expect(hits).toEqual([]);
    },
  );
});

describe("redesign-only dependencies stay out — MKT-PIN T5", () => {
  it.each(PINNED_ABSENT_DEPENDENCIES)(
    "apps/web/package.json has no %s dependency (MKT-PIN T5)",
    (dep) => {
      expect(Object.prototype.hasOwnProperty.call(webPackageDependencyNames(), dep)).toBe(false);
    },
  );
});

const MARKETING_CSS_PATH = path.join(WEB_ROOT, "app", "(marketing)", "marketing.css");

// Present in marketing.css today (line 802 at plan time) — removing it is the
// requirement.
const BANNED_CSS_TOKENS = ["color-mix(in oklch"];
// Never present in marketing.css — standing guards against the port
// reintroducing Tailwind-4-only syntax. MKT-PIN, so out of the red gate.
const PINNED_ABSENT_CSS_TOKENS = [
  "@theme",
  "@custom-variant",
  "has-data-",
  "in-data-",
  "field-sizing",
  "data-starting-style",
];

describe("marketing.css avoids Tailwind-4-only syntax — R-MKT T5", () => {
  it.each(BANNED_CSS_TOKENS)('marketing.css does not contain "%s" (R-MKT T5)', (token) => {
    const css = fs.readFileSync(MARKETING_CSS_PATH, "utf8");
    expect(css).not.toContain(token);
  });
});

describe("marketing.css keeps avoiding Tailwind-4-only syntax — MKT-PIN T5", () => {
  it.each(PINNED_ABSENT_CSS_TOKENS)('marketing.css does not contain "%s" (MKT-PIN T5)', (token) => {
    const css = fs.readFileSync(MARKETING_CSS_PATH, "utf8");
    expect(css).not.toContain(token);
  });
});

// ---------------------------------------------------------------------------
// T6 — manifests + root layout point at the new mark; production
// metadataBase.
// ---------------------------------------------------------------------------

type ManifestIcon = { src: string; sizes?: string; type?: string; purpose?: string };

function readManifest(relPath: string): { icons: ManifestIcon[] } {
  return JSON.parse(fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8"));
}

describe("PWA manifests point at the new mark — R-MKT T6", () => {
  it.each(["public/operator-manifest.json", "public/buyer-manifest.json"])(
    "%s icons all start with /brand/routeflow-mark- and resolve on disk (R-MKT T6)",
    (relPath) => {
      const manifest = readManifest(relPath);
      expect(Array.isArray(manifest.icons)).toBe(true);
      expect(manifest.icons.length).toBeGreaterThan(0);
      for (const icon of manifest.icons) {
        expect(icon.src).toEqual(expect.stringMatching(/^\/brand\/routeflow-mark-/));
        const onDisk = path.join(WEB_ROOT, "public", icon.src.replace(/^\//, ""));
        expect(fs.existsSync(onDisk)).toBe(true);
      }
    },
  );
});

describe("root layout.tsx — R-MKT T6", () => {
  it("sets metadataBase to https://www.routeflow.info and drops /logo.svg (R-MKT T6)", () => {
    const source = fs.readFileSync(path.join(WEB_ROOT, "app", "layout.tsx"), "utf8");
    expect(source).toContain('metadataBase: new URL("https://www.routeflow.info")');
    expect(source).not.toContain("/logo.svg");
  });
});

// The App Router drops the `not-found` segment's own CSS chunk on hydration, so
// marketing.css has to be imported from the root layout for `app/not-found.tsx`
// to be styled at all. That only stays safe while marketing.css shares no
// unscoped at-rule name with globals.css.
describe("marketing.css is delivered from the root layout — R-MKT T6", () => {
  it("root layout.tsx imports the marketing stylesheet (R-MKT T6)", () => {
    const source = fs.readFileSync(path.join(WEB_ROOT, "app", "layout.tsx"), "utf8");
    expect(source).toContain('import "./(marketing)/marketing.css"');
  });

  // Exactly once, and only from the root: a second segment-level import would
  // double-ship a 214,999 B (35,939 B gzip) stylesheet. The root import is a
  // recorded, accepted deviation — see the `Deviations` section of the run's
  // ux-spec and the comment above the import in app/layout.tsx.
  it("marketing.css is imported once, from app/layout.tsx only (R-MKT T6)", () => {
    const importers: string[] = [];
    for (const dir of [path.join(WEB_ROOT, "app"), path.join(WEB_ROOT, "components")]) {
      for (const file of walkTextFiles(dir)) {
        if (file === __filename) continue;
        const text = fs.readFileSync(file, "utf8");
        for (const line of text.split("\n")) {
          if (/^\s*import\s+["'][^"']*marketing\.css["']\s*;?\s*$/.test(line)) {
            importers.push(path.relative(WEB_ROOT, file).split(path.sep).join("/"));
          }
        }
      }
    }
    expect(importers).toEqual(["app/layout.tsx"]);
  });

  it("marketing.css declares no @keyframes name also declared in globals.css (R-MKT T6)", () => {
    const names = (css: string) =>
      (css.match(/@keyframes\s+([A-Za-z0-9_-]+)/g) ?? []).map((m) => m.split(/\s+/)[1]);
    const marketing = names(fs.readFileSync(MARKETING_CSS_PATH, "utf8"));
    const globals = names(fs.readFileSync(path.join(WEB_ROOT, "app", "globals.css"), "utf8"));
    expect(marketing.filter((n) => globals.includes(n))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T7 — globals.css / tailwind.config.ts pinned byte-identical to the branch
// baseline (5ddec78e); marketing.css declares no :root and every custom
// property it declares sits under a .rf-marketing-scoped selector.
// ---------------------------------------------------------------------------

// Hashes computed from this repo at branch base 5ddec78e (`git diff 5ddec78e
// -- <path>` is empty for both at plan time — see the test-plan's T7 row).
// globals.css re-pinned by B511 (touch-reveal media query, a legitimate
// unrelated dashboard change — this pin exists to catch the marketing port
// leaking into shared files, not to freeze globals.css forever).
const GLOBALS_CSS_SHA256 = "01b57813d6654b2407573517d22b9e12a0587551f731aaebb3b8696ce1fd6461";
const TAILWIND_CONFIG_SHA256 = "5b62085fee3f38bba484393c94238b8651806d8c7e0e47efc9a91cce68ff9754";

function sha256OfFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// Returns one entry per top-level custom-property declaration
// (`--token: value;`, one per line in this prettier-formatted stylesheet)
// whose nearest enclosing selector does not mention .rf-marketing.
function customPropertyScopeViolations(css: string): string[] {
  const violations: string[] = [];
  const selectorStack: string[] = [];

  for (const raw of css.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    if (/^--[\w-]+\s*:/.test(line)) {
      const scope = selectorStack[selectorStack.length - 1] ?? "";
      if (!scope.includes(".rf-marketing")) {
        violations.push(`"${line}" declared under "${scope || "(top level)"}"`);
      }
      continue;
    }

    if (line.endsWith("{")) {
      selectorStack.push(line.slice(0, -1).trim());
      continue;
    }

    if (/^}+$/.test(line)) {
      for (let i = 0; i < line.length; i++) selectorStack.pop();
    }
  }

  return violations;
}

// All three rows are GREEN on the untouched tree: the two sha256 rows are pins
// by design, and marketing.css already declares no `:root` (verified — the file
// opens `.rf-marketing {` and every token sits inside it). They therefore carry
// the MKT-PIN token and stay out of the red gate; they still run in the full
// `npx jest` suite, which is where they earn their keep — the port must not
// break the containment they record.
describe("pinned global styles — MKT-PIN T7", () => {
  it("app/globals.css is byte-identical to the branch baseline (MKT-PIN T7)", () => {
    expect(sha256OfFile(path.join(WEB_ROOT, "app", "globals.css"))).toBe(GLOBALS_CSS_SHA256);
  });

  it("packages/config/tailwind.config.ts is byte-identical to the branch baseline (MKT-PIN T7)", () => {
    expect(sha256OfFile(path.join(REPO_ROOT, "packages", "config", "tailwind.config.ts"))).toBe(
      TAILWIND_CONFIG_SHA256,
    );
  });

  it("marketing.css declares no :root and scopes every custom property under .rf-marketing (MKT-PIN T7)", () => {
    const css = fs.readFileSync(MARKETING_CSS_PATH, "utf8");
    expect(css).not.toMatch(/:root\s*\{/);
    expect(customPropertyScopeViolations(css)).toEqual([]);
  });
});

// One focus ring for the whole marketing surface, on the `--ring` token at the
// ux-spec §5 width/offset. The port arrived with two competing global rules
// (a blue `a|button|input|textarea|summary:focus-visible` ring and a mauve
// `:focus-visible` one), so a `[tabindex]` element got a different ring than a
// button on the same page and neither used `--ring`.
describe("marketing.css ships one tokenised focus ring — R-MKT T7", () => {
  it("the global focus ring uses var(--ring) at 2px/2px (R-MKT T7)", () => {
    const css = fs.readFileSync(MARKETING_CSS_PATH, "utf8");
    expect(css).toContain("outline: 2px solid var(--ring)");
    expect(css).toContain("outline-offset: 2px");
  });

  it("no outline declaration hardcodes the two ported ring colours (R-MKT T7)", () => {
    const css = fs.readFileSync(MARKETING_CSS_PATH, "utf8");
    expect(css).not.toMatch(/outline[^;{}]*#245be8/i);
    expect(css).not.toMatch(/outline[^;{}]*#91809f/i);
  });
});

// ---------------------------------------------------------------------------
// Sign-in menu items — owner screenshot 2026-09-08: the item was an inline
// `<a>` whose icon/label/arrow sat in different line boxes, so :focus-visible
// painted one outline rectangle per wrapped fragment instead of one ring
// around the row. Fix: the item is a `display: flex` row (`white-space:
// nowrap` keeps it to one line at the panel's own min-width) so the anchor
// generates a single box, plus a dedicated :focus-visible ring on the anchor
// and an explicit `outline: none` on its children so a ring can never
// re-fragment across the icon/label/arrow.
// ---------------------------------------------------------------------------

type CssRule = { selector: string; body: string };

// Line-based rule walker, same technique as customPropertyScopeViolations
// above: the stylesheet is prettier-formatted with one selector/declaration
// per line, so tracking brace depth finds each TOP-LEVEL rule's own body
// without tripping over nested @media blocks or the same selector text
// repeated elsewhere in this ~10k-line, multi-file-ported stylesheet (this
// file legitimately declares `.signin-menu [role="menuitem"]` more than
// once — a structural layer and a separate visual layer — so a plain
// `.indexOf`/`.match` would silently grab the wrong one).
function parseTopLevelRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  let depth = 0;
  let pendingSelector: string | null = null;
  let bodyLines: string[] = [];
  for (const raw of css.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.endsWith("{")) {
      if (depth === 0) {
        pendingSelector = line.slice(0, -1).trim();
        bodyLines = [];
      }
      depth++;
      continue;
    }
    if (/^}+$/.test(line)) {
      for (let i = 0; i < line.length; i++) {
        depth--;
        if (depth === 0 && pendingSelector !== null) {
          rules.push({ selector: pendingSelector, body: bodyLines.join("\n") });
          pendingSelector = null;
        }
      }
      continue;
    }
    if (depth === 1 && pendingSelector !== null) {
      bodyLines.push(line);
    }
  }
  return rules;
}

const SIGNIN_ITEM_SELECTOR = '.rf-marketing .signin-menu [role="menuitem"]';
const SIGNIN_ITEM_FOCUS_VISIBLE_SELECTOR = `${SIGNIN_ITEM_SELECTOR}:focus-visible`;
const SIGNIN_ITEM_BARE_SELECTORS = new Set([
  SIGNIN_ITEM_SELECTOR,
  `${SIGNIN_ITEM_SELECTOR}:hover`,
  `${SIGNIN_ITEM_SELECTOR}:focus`,
  SIGNIN_ITEM_FOCUS_VISIBLE_SELECTOR,
]);

describe("sign-in menu items are one flex row with a single focus ring — R-MKT signin-menu", () => {
  it("the menu item's structural rule sets display: flex and white-space: nowrap (R-MKT signin-menu)", () => {
    const rules = parseTopLevelRules(fs.readFileSync(MARKETING_CSS_PATH, "utf8"));
    const structural = rules.find(
      (r) => r.selector === SIGNIN_ITEM_SELECTOR && r.body.includes("display: flex"),
    );
    expect(structural).toBeDefined();
    expect(structural!.body).toContain("white-space: nowrap");
  });

  it("the menu item carries its own :focus-visible ring with an outline-offset (R-MKT signin-menu)", () => {
    const rules = parseTopLevelRules(fs.readFileSync(MARKETING_CSS_PATH, "utf8"));
    const ownRing = rules.find(
      (r) => r.selector === SIGNIN_ITEM_FOCUS_VISIBLE_SELECTOR && r.body.includes("outline:"),
    );
    expect(ownRing).toBeDefined();
    expect(ownRing!.body).toContain("outline-offset");
  });

  it("no rule paints a visible outline on the item's inner icon/label/arrow (R-MKT signin-menu)", () => {
    const rules = parseTopLevelRules(fs.readFileSync(MARKETING_CSS_PATH, "utf8"));
    const innerRules = rules.filter(
      (r) =>
        r.selector.includes(".signin-menu") &&
        r.selector.includes('[role="menuitem"]') &&
        !SIGNIN_ITEM_BARE_SELECTORS.has(r.selector),
    );
    // The item's children must be explicitly neutralised (`> * { outline:
    // none }`) — that rule not existing yet is exactly the pre-fix state.
    expect(innerRules.length).toBeGreaterThan(0);
    for (const rule of innerRules) {
      expect(rule.body).not.toMatch(/outline\s*:\s*(?!none\b)\S/);
    }
    expect(innerRules.some((r) => /outline\s*:\s*none\b/.test(r.body))).toBe(true);
  });
});
