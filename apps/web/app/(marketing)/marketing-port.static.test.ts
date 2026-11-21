import * as fs from "fs";
import * as os from "os";
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

type PinnedExclusion = {
  file: string;
  lineMustContain: string;
  count: number;
  ruling: string;
};

// A hit is skipped ONLY when it is in the named file AND its own line holds the named text.
function scanReferences(
  dirs: string[],
  needle: string,
  root: string,
  exclusion?: PinnedExclusion,
  self?: string,
): { hits: Array<{ file: string; line: number }>; excluded: number } {
  const hits: Array<{ file: string; line: number }> = [];
  let excluded = 0;
  for (const dir of dirs) {
    for (const file of walkTextFiles(dir)) {
      // This file itself legitimately names every banned string as a
      // string literal for the scan below — never flag itself.
      if (file === self) continue;
      const rel = path.relative(root, file).split(path.sep).join("/");
      const text = fs.readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (!line.includes(needle)) return;
        if (exclusion && rel === exclusion.file && line.includes(exclusion.lineMustContain)) {
          excluded++;
          return;
        }
        hits.push({ file: path.relative(root, file), line: i + 1 });
      });
    }
  }
  return { hits, excluded };
}

function findSourceReferences(
  dirs: string[],
  needle: string,
  exclusion?: PinnedExclusion,
): Array<{ file: string; line: number }> {
  return scanReferences(dirs, needle, REPO_ROOT, exclusion, __filename).hits;
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

// The one named exception (SA-1203 A31): the copper guard's own source names the brand favicon path
// (its LEGIT_REDS entry and a plant). Exactly `count` such lines, in that file only.
const PINNED_FAVICON_EXCLUSION: PinnedExclusion = {
  file: "apps/web/app/(marketing)/site-repaint-1a.static.test.ts",
  lineMustContain: "img/brand/favicon.svg",
  count: 3,
  ruling: "SA-1203 A31",
};

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
      const hits = findSourceReferences(SCAN_DIRS, needle, PINNED_FAVICON_EXCLUSION);
      expect(hits).toEqual([]);
    },
  );

  it("the favicon exclusion matched exactly its pinned count of lines (SA-1203 A31)", () => {
    const r = scanReferences(
      SCAN_DIRS,
      "favicon.svg",
      REPO_ROOT,
      PINNED_FAVICON_EXCLUSION,
      __filename,
    );
    expect(r.excluded).toBe(PINNED_FAVICON_EXCLUSION.count);
  });

  describe("the exclusion is narrow (fixtures)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-pin-"));
    const rel = "apps/web/app/(marketing)/site-repaint-1a.static.test.ts";
    const brand = 'const a = "img/brand/favicon.svg";\n';
    const run = (files: Record<string, string>) => {
      for (const [name, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), body);
      }
      return scanReferences([path.join(root, "apps")], "favicon.svg", root, {
        ...PINNED_FAVICON_EXCLUSION,
        file: rel,
      });
    };
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    it("three brand-path lines in the named file are skipped", () => {
      const r = run({ [rel]: brand.repeat(3) });
      expect(r.hits).toEqual([]);
      expect(r.excluded).toBe(PINNED_FAVICON_EXCLUSION.count);
    });
    it("a bare /favicon.svg line in the named file is red", () => {
      const r = run({ [rel]: brand.repeat(3) + 'const b = "/favicon.svg";\n' });
      expect(r.hits).toHaveLength(1);
    });
    it("a fourth brand-path line moves the count off the pin, so the count test is red", () => {
      expect(run({ [rel]: brand.repeat(4) }).excluded).not.toBe(PINNED_FAVICON_EXCLUSION.count);
    });
    it("the brand path in another file is red", () => {
      const r = run({ [rel]: brand.repeat(3), "apps/web/app/other.ts": brand });
      expect(r.hits).toHaveLength(1);
    });
  });
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
  "public/marketing/order-builder.webp",
  "public/marketing/invoice-detail.webp",
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
// (apps/web/components/DateRangePicker.tsx and eight
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
  it("sets metadataBase from the brand seam (BRAND.origin) and drops /logo.svg (R-MKT T6)", () => {
    const source = fs.readFileSync(path.join(WEB_ROOT, "app", "layout.tsx"), "utf8");
    expect(source).toContain("metadataBase: new URL(BRAND.origin)");
    expect(source).not.toContain("www.routeflow.info");
    expect(source).not.toContain("/logo.svg");
  });
});

// The four front-door stylesheets (marketing.css, glass.css, glass-pages.css, glass-site.css) were
// retired by lane 2.6b and deleted with their root imports (wave 1b): the root layout imports none of
// them, no file imports one, and the files are gone. The same facts are pinned per registry id in
// site-front-door-css.static.test.ts.
const FRONT_DOOR_CSS = ["marketing.css", "glass.css", "glass-pages.css", "glass-site.css"];

describe("the front-door stylesheets are not delivered from the root layout — R-MKT T6", () => {
  it("root layout.tsx imports none of the four front-door stylesheets (R-MKT T6)", () => {
    const source = fs.readFileSync(path.join(WEB_ROOT, "app", "layout.tsx"), "utf8");
    for (const name of FRONT_DOOR_CSS) expect(source).not.toContain(name);
  });

  it("no file under app/ or components/ imports any of them, and the files are gone (R-MKT T6)", () => {
    const importers: string[] = [];
    for (const dir of [path.join(WEB_ROOT, "app"), path.join(WEB_ROOT, "components")]) {
      for (const file of walkTextFiles(dir)) {
        if (file === __filename) continue;
        const text = fs.readFileSync(file, "utf8");
        for (const line of text.split("\n")) {
          if (
            /^\s*import\s+["'][^"']*(marketing|glass|glass-pages|glass-site)\.css["']/.test(line)
          ) {
            importers.push(path.relative(WEB_ROOT, file).split(path.sep).join("/"));
          }
        }
      }
    }
    expect(importers).toEqual([]);
    for (const name of FRONT_DOOR_CSS) {
      expect(fs.existsSync(path.join(WEB_ROOT, "app", "(marketing)", name))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// T7 — globals.css / tailwind.config.ts pinned byte-identical to the branch
// baseline (5ddec78e).
// ---------------------------------------------------------------------------

// Hashes computed from this repo at branch base 5ddec78e (`git diff 5ddec78e
// -- <path>` is empty for both at plan time — see the test-plan's T7 row).
// globals.css re-pinned by #2080 (date/time-input appearance-none rule, a
// legitimate unrelated dashboard change — this pin exists to catch the
// marketing port leaking into shared files, not to freeze globals.css
// forever; see B511 above for the same precedent). Re-pinned again by #2497 (the `.overline`
// label class renamed `.eyebrow-label` — it collided with Tailwind's `overline` utility; a
// dashboard fix, not marketing leakage). Re-pinned again by the V12 --field token (the input-border
// colour, mirrored in the Ledger token source) on the same #2080/#2497 precedent: a dashboard
// control token, not marketing leakage. Re-pinned again by W-928 (the `prefers-reduced-motion` rule
// that stops the Tailwind enter / exit animation on every overlay) on the same precedent: an
// accessibility rule for the dashboard overlays, not marketing leakage. Re-pinned again by SA-1071 A-2
// (the 16px field rule on touch, so iOS doesn't zoom) on the same precedent: an app-wide rule, not
// marketing leakage. Re-pinned again by W-1185 (the item-count chip pulse, inside the
// `prefers-reduced-motion: no-preference` block) on the same precedent: a dashboard rule, not
// marketing leakage.
const GLOBALS_CSS_SHA256 = "f5cc37a9c40070f57bdc4243f3a7ce3b1cd0faa8a2941294b35c3b4d18768d17";
// tailwind.config.ts re-pinned by #2329: the preset now builds its values from the shared
// Ledger token source (packages/ui/src/tokens/ledger.ts). Behaviour-preserving — the compiled
// web CSS is byte-identical before and after — and unrelated to the marketing port.
const TAILWIND_CONFIG_SHA256 = "5731ba0cb3c580056ec0c57b3cd90d5e529828fbb0aa549913afbdbd096c03c0";

function sha256OfFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// Both rows are pins by design (MKT-PIN, out of the red gate); they run in the full suite.
describe("pinned global styles — MKT-PIN T7", () => {
  it("app/globals.css is byte-identical to the branch baseline (MKT-PIN T7)", () => {
    expect(sha256OfFile(path.join(WEB_ROOT, "app", "globals.css"))).toBe(GLOBALS_CSS_SHA256);
  });

  it("packages/config/tailwind.config.ts is byte-identical to the branch baseline (MKT-PIN T7)", () => {
    expect(sha256OfFile(path.join(REPO_ROOT, "packages", "config", "tailwind.config.ts"))).toBe(
      TAILWIND_CONFIG_SHA256,
    );
  });
});

// One focus ring for the whole front door. The port once arrived with two competing global rings;
// since lane 2.6b the four front-door stylesheets are empty (every rule was scoped under a class no
// page wears, see site-front-door-css.static.test.ts), so the one ring is the ready-made site's own
// global :focus-visible rule in public/site/css/site.css, which the SiteFrame pages load.
describe("the front door has one focus ring and the site stylesheet owns it — R-MKT T7", () => {
  it("the ready-made site's global :focus-visible rule draws the ring the frame pages use (R-MKT T7)", () => {
    const css = fs.readFileSync(path.join(WEB_ROOT, "public", "site", "css", "site.css"), "utf8");
    expect(css).toMatch(/(^|\n)\s*:focus-visible\s*\{[^}]*outline:\s*3px solid/);
  });
});

// ---------------------------------------------------------------------------
// Sign-in menu items. The rules for the old marketing header's `.signin-menu` (one flex row, one
// focus ring, owner screenshot 2026-09-08) left with that header: the header is now the SiteFrame
// header, which has no such menu. The pin keeps its place and now holds the other half: nothing
// emits the class and the stylesheets that carried a rule for it are deleted.
// ---------------------------------------------------------------------------

describe("the old sign-in menu is gone with its stylesheet rules — R-MKT signin-menu", () => {
  it("no source emits .signin-menu (R-MKT signin-menu)", () => {
    const emitters = findSourceReferences(SCAN_DIRS, "signin-menu").filter(
      (h) => !/\.(css|test\.tsx?)$/.test(h.file),
    );
    expect(emitters).toEqual([]);
  });
});
