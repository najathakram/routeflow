/**
 * @jest-environment node
 */
// T35: the brand seam. Nothing that names the brand is typed outside packages/types/brand/brand.json:
// the ready-made pages, the site frame, the (marketing) libs, the auth screens and the share image
// read it. This is a class pin over the whole surface, not a list of known strings, so a new page or
// a new literal cannot slip past it (lesson L-072: a hand-typed mirror is how bugs ship).
//
// Wave 0 (S1) makes the eight inner pages, the frame, lib/site.ts, lib/metadata.ts, the og route and
// umami-tag.ts clean. Everything else that still names the brand is listed ONCE in EXEMPT below with
// the wave that lifts it (lib/test-support/site-brand-exemptions.ts, shared with T45). A row is
// deleted when its lane merges: the test fails when an exempt file no longer exists (a deleted file
// cannot hide its row) and when an exempt scope no longer contains the thing it is exempt for
// ("stale exemption: remove the row").
import * as fs from "fs";
import * as path from "path";
import {
  EXEMPT,
  brandLiteral,
  exemptionFor,
  type Exemption,
} from "@/lib/test-support/site-brand-exemptions";

const WEB = path.resolve(__dirname, "../..");

/** Identifiers that carry the old spelling on purpose; stripped before matching, exact strings only. */
const ALLOWED_IDENTIFIERS = [
  "RouteFlowShell",
  "routeflow-v4",
  "/brand/routeflow-mark",
  // the workspace package that holds brand.json: the one import every reader needs
  "@routeflow/types/brand",
  // workspace packages the sign-in pages import (a package name, not a brand string)
  "@routeflow/ui/web",
  "@routeflow/types",
  // the security policy in the public code repository (lib/repo-links.ts): a code location
  "https://github.com/najathakram/routeflow/blob/master/SECURITY.md",
];
const RF_PREFIX = /\brf-[a-z0-9-]+/gi;

/** The old mark's SVG path data (rf-wheel-up.js hub, home.html still). */
const TYPED_MARK = /M0 96V34a18|M66 2l14 14l-14 14|M26 96V52a8/;
const HEX_IN_ATTR = /\b(?:style|fill|stroke)="[^"]*#[0-9a-fA-F]{3,8}\b/g;
const HEX = /#[0-9a-fA-F]{3,8}\b/;

/** The surface. Each entry must match at least one file or the test throws (fail closed). */
const SURFACE: Array<{ name: string; dir: string; ext: RegExp; topOnly?: boolean }> = [
  { name: "public/site", dir: "public/site", ext: /\.(html|js|css)$/ },
  { name: "site-frame", dir: "components/site-frame", ext: /\.(tsx?|css)$/ },
  { name: "(marketing)", dir: "app/(marketing)", ext: /\.(tsx?|css)$/ },
  { name: "(auth)", dir: "app/(auth)", ext: /\.(tsx?|css)$/ },
  { name: "buyer/login", dir: "app/buyer/login", ext: /\.(tsx?|css)$/ },
  { name: "not-found", dir: "app", ext: /^not-found\.tsx$/, topOnly: true },
  { name: "verify-email", dir: "app/verify-email", ext: /\.(tsx?|css)$/ },
  { name: "umami-tag", dir: "lib", ext: /^umami-tag\.ts$/, topOnly: true },
  {
    name: "front-door libs",
    dir: "lib",
    ext: /^(front-door-metadata|brand-domain|repo-links)\.ts$/,
    topOnly: true,
  },
];
const IS_TEST = /\.(test|spec)\.[tj]sx?$/;

function walk(dir: string, ext: RegExp, topOnly: boolean): string[] {
  const abs = path.join(WEB, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!topOnly && entry.name !== "node_modules") out.push(...walk(rel, ext, false));
    } else if (ext.test(entry.name) && !IS_TEST.test(entry.name)) out.push(rel);
  }
  return out;
}

function surfaceFiles(surface = SURFACE): string[] {
  const all = new Set<string>();
  for (const s of surface) {
    const files = walk(s.dir, s.ext, s.topOnly === true);
    if (files.length === 0) throw new Error(`T35: the "${s.name}" glob matched no file`);
    for (const f of files) all.add(f);
  }
  return [...all].sort();
}

function stripComments(file: string, text: string): string {
  if (file.endsWith(".html")) return text.replace(/<!--[\s\S]*?-->/g, "");
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  if (file.endsWith(".css")) return noBlock;
  return noBlock.replace(/^\s*\/\/.*$/gm, "").replace(/(^|[ \t])\/\/ .*$/gm, "$1");
}

function literalCount(text: string): number {
  let t = text.replace(RF_PREFIX, "");
  for (const id of ALLOWED_IDENTIFIERS) t = t.split(id).join("");
  return (t.match(brandLiteral()) ?? []).length;
}

const OG_ROUTE = "app/(marketing)/opengraph-image/route.tsx";
const read = (file: string) => fs.readFileSync(path.join(WEB, file), "utf8");

interface Finding {
  file: string;
  what: string;
  count: number;
}

/** What the scan flags in one file, given the exemption rows in force. */
function scanFile(file: string, rows: Exemption[]): Finding[] {
  const findings: Finding[] = [];
  const scopes = exemptionFor(file, rows).map((e) => e.scope);
  if (scopes.includes("file")) return findings;
  const text = read(file);
  const nameText = scopes.includes("comments") ? stripComments(file, text) : text;
  const names = literalCount(nameText);
  if (names) findings.push({ file, what: "brand literal", count: names });
  if (TYPED_MARK.test(text)) findings.push({ file, what: "typed mark path", count: 1 });
  if (!scopes.includes("hex") && file.endsWith(".html")) {
    const attrs = text.match(HEX_IN_ATTR);
    if (attrs) findings.push({ file, what: "hex in style/fill", count: attrs.length });
  }
  if (!scopes.includes("hex") && OG_ROUTE === file && HEX.test(text)) {
    findings.push({ file, what: "hex in the share image", count: 1 });
  }
  if (!scopes.includes("hex") && file.endsWith("graphics/rf-wheel-up.js") && HEX.test(text)) {
    findings.push({ file, what: "hex in the wheel", count: 1 });
  }
  return findings;
}

const scan = (rows: Exemption[] = EXEMPT): Finding[] =>
  surfaceFiles().flatMap((file) => scanFile(file, rows));

/** Control fixtures (SA-1198): outside the real SURFACE on purpose, so a control never reads a page. */
const FIXTURES_DIR = "lib/test-support/fixtures";
const FIXTURE_SURFACE: typeof SURFACE = [{ name: "fixtures", dir: FIXTURES_DIR, ext: /\.html$/ }];
const FX_BOTH = `${FIXTURES_DIR}/hex-and-name.html`;
const FX_CLEAN = `${FIXTURES_DIR}/clean.html`;
const FX_HEX_ONLY = `${FIXTURES_DIR}/hex-only.html`;
const FX_NAME_IN_COMMENT = `${FIXTURES_DIR}/name-in-comment.html`;
const mkRow = (p: string, scope: Exemption["scope"]): Exemption => ({
  path: p,
  scope,
  liftedBy: "W3",
  lane: "test",
});

const HEX_KINDS = new Set(["hex in style/fill", "hex in the share image", "hex in the wheel"]);

/** A row is stale when taking it away leaves the file with nothing it was exempt for: any finding
 *  for a `file` row except hex alone (a hex-only file needs a `hex` row), a name for `comments`,
 *  a hex finding for `hex`. Rows name one file each. */
function isStale(
  row: Exemption,
  all: Exemption[] = EXEMPT,
  surface: typeof SURFACE = SURFACE,
): boolean {
  const without = all.filter((e) => e !== row);
  const findings = surfaceFiles(surface).includes(row.path) ? scanFile(row.path, without) : [];
  const kinds = findings.map((f) => f.what);
  if (row.scope === "hex") return !kinds.some((k) => HEX_KINDS.has(k));
  if (row.scope === "comments") return !kinds.includes("brand literal");
  return !kinds.some((k) => !HEX_KINDS.has(k));
}

describe("T35: the brand seam", () => {
  it("the surface globs all match files", () => {
    expect(() => surfaceFiles()).not.toThrow();
    expect(surfaceFiles().length).toBeGreaterThan(40);
  });

  it("a glob that matches no file throws instead of passing", () => {
    expect(() =>
      surfaceFiles([{ name: "nothing", dir: "public/site/no-such-dir", ext: /\.html$/ }]),
    ).toThrow(/matched no file/);
  });

  it("every exempt path still exists (a deleted file cannot hide its row)", () => {
    const missing = EXEMPT.filter((e) => !fs.existsSync(path.join(WEB, e.path))).map((e) => e.path);
    expect(missing).toEqual([]);
  });

  it("every exemption still exempts something (a lane that cleans a file deletes its row)", () => {
    const stale = EXEMPT.filter((e) => isStale(e)).map(
      (e) => `stale exemption: remove the row for ${e.path} (${e.lane}, ${e.liftedBy})`,
    );
    expect(stale).toEqual([]);
  });

  it("W3 closed: no file is exempt (SA-1198)", () => expect(EXEMPT).toEqual([]));

  it("the real surface never matches the fixtures directory", () => {
    expect(surfaceFiles().filter((f) => f.startsWith(`${FIXTURES_DIR}/`))).toEqual([]);
  });

  it("a file-scope row does not stay alive on hex-only findings (that is a hex row)", () => {
    // The hex-only fixture has one inline hex and no name: a file row exempts nothing but the hex.
    const surface = [...SURFACE, ...FIXTURE_SURFACE];
    const wrong = mkRow(FX_HEX_ONLY, "file");
    const hex = mkRow(FX_HEX_ONLY, "hex");
    expect(isStale(wrong, [wrong], surface)).toBe(true);
    expect(isStale(hex, [hex], surface)).toBe(false);
  });

  it("no row names a directory: each exempts files, one by one", () => {
    expect(EXEMPT.filter((e) => e.path.endsWith("/"))).toEqual([]);
  });

  it("the staleness check goes red on a row that exempts nothing", () => {
    const dead: Exemption = {
      path: "public/site/contact.html",
      scope: "file",
      liftedBy: "W2",
      lane: "test",
    };
    expect(isStale(dead, [...EXEMPT, dead])).toBe(true);
    // Live controls come from the fixture, never from a real page or a row of the list.
    const surface = [...SURFACE, ...FIXTURE_SURFACE];
    for (const scope of ["hex", "comments", "file"] as const) {
      const live = mkRow(FX_BOTH, scope);
      expect(isStale(live, [live], surface)).toBe(false);
    }
    const deadTwin = mkRow(FX_CLEAN, "file");
    expect(isStale(deadTwin, [deadTwin], surface)).toBe(true);
  });

  it("a comments row is judged by the name, not by the hex or the file", () => {
    const surface = [...SURFACE, ...FIXTURE_SURFACE];
    // hex but no name: the comments row exempts nothing.
    const onHexOnly = mkRow(FX_HEX_ONLY, "comments");
    expect(isStale(onHexOnly, [onHexOnly], surface)).toBe(true);
    // the name sits only in a comment: the comments scope strips it, unscoped it is seen.
    const commentsRow = mkRow(FX_NAME_IN_COMMENT, "comments");
    expect(scanFile(FX_NAME_IN_COMMENT, [commentsRow]).map((f) => f.what)).not.toContain(
      "brand literal",
    );
    expect(scanFile(FX_NAME_IN_COMMENT, []).map((f) => f.what)).toContain("brand literal");
  });

  it("the eight inner pages, the frame, lib/site, lib/metadata, the og route and umami-tag are in the surface and not file-exempt", () => {
    const mustBeClean = [
      ...[
        "pricing",
        "product",
        "company",
        "contact",
        "getting-started",
        "does-and-doesnt",
        "data-in-and-out",
        "security",
      ].map((p) => `public/site/${p}.html`),
      "components/site-frame/SiteFrame.tsx",
      "components/site-frame/SiteFrameHeader.tsx",
      "components/site-frame/site-frame-nav.ts",
      "app/(marketing)/lib/site.ts",
      "app/(marketing)/lib/metadata.ts",
      "app/(marketing)/opengraph-image/route.tsx",
      "lib/umami-tag.ts",
    ];
    const surface = new Set(surfaceFiles());
    for (const f of mustBeClean) {
      expect(surface.has(f)).toBe(true);
      expect(exemptionFor(f).filter((e) => e.scope !== "hex")).toEqual([]);
    }
  });

  it("no brand literal, typed mark path or hex in a style/fill attribute outside the exemption table", () => {
    const findings = scan();
    const total = findings.reduce((n, f) => n + f.count, 0);
    const per = findings
      .map((f) => `${f.count}\t${f.what}\t${f.file}`)
      .sort()
      .join("\n");
    expect(per ? `${total} findings\n${per}` : "").toBe("");
  });
});
