import * as fs from "fs";
import * as path from "path";

/**
 * SA-1139 fix round 1 (MUST 1), widened by SA-1154: the dashboard shell mounts the embedded-checkout host on every
 * page, so no Stripe code may load until a checkout is open.
 *   - The main `@stripe/stripe-js` entry injects js.stripe.com at module load. No specifier of it may appear in any
 *     non-test file under `apps/web` or `packages/ui`: not the bare name, not a deep path (`.../dist/...`), not a
 *     template literal. Only the exact `/pure` entry is allowed.
 *   - The panel (Stripe.js and the React bindings) is reached only through the host's `dynamic(() => import(...))`.
 *     Any static import, re-export or `require` of it, anywhere, and any dynamic import of it outside the host, fails.
 */
const WEB_ROOT = path.resolve(__dirname, "..");
const UI_ROOT = path.resolve(WEB_ROOT, "../../packages/ui");
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "coverage",
  "e2e",
  "playwright-report",
  "dist",
]);

const HOST = "components/billing/EmbeddedCheckoutHost.tsx";
const PANEL = "components/billing/EmbeddedCheckoutPanel.tsx";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !/\.test\.[tj]sx?$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** The main entry of the Stripe.js loader in ANY spelling except exactly `@stripe/stripe-js/pure`. */
const NOT_PURE_STRIPE_JS = /@stripe\/stripe-js(?!\/pure["'`])/;
/** A module specifier written as `from "x"`, `import "x"`, `import("x")` or `require("x")` (any quote, template too). */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'`])((?:(?!\1)[^\n])*)\1/g;
const PANEL_SPECIFIER = /(?:^|\/)EmbeddedCheckoutPanel(?:\.tsx?)?$/;
const STRIPE_REACT = /["'`]@stripe\/react-stripe-js["'`]/;
const PURE_STRIPE_JS = /["'`]@stripe\/stripe-js\/pure["'`]/;

/** What `file` (a path relative to apps/web) breaks, given its text. Empty when it is fine. */
export function stripeEntryViolations(file: string, text: string): string[] {
  const out: string[] = [];
  if (NOT_PURE_STRIPE_JS.test(text)) out.push("main @stripe/stripe-js entry");
  if ((PURE_STRIPE_JS.test(text) || STRIPE_REACT.test(text)) && file !== PANEL) {
    out.push("Stripe code outside the panel");
  }
  for (const m of text.matchAll(SPECIFIER)) {
    if (!PANEL_SPECIFIER.test(m[2])) continue;
    const quoteAt = (m.index ?? 0) + m[0].indexOf(m[1]);
    const dynamicImport = /\bimport\s*\(\s*$/.test(text.slice(0, quoteAt));
    if (!dynamicImport) out.push("static import of the panel");
    else if (file !== HOST) out.push("dynamic import of the panel outside the host");
  }
  return out;
}

const rel = (f: string) => path.relative(WEB_ROOT, f).split(path.sep).join("/");

describe("Stripe entry pins (SA-1139, SA-1154)", () => {
  const files = [...sourceFiles(WEB_ROOT), ...sourceFiles(UI_ROOT)];

  it("scans the real trees (guards against an empty walk)", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.map(rel)).toContain(PANEL);
    expect(files.some((f) => f.startsWith(UI_ROOT))).toBe(true);
  });

  it("no non-test file under apps/web or packages/ui breaks a Stripe entry rule", () => {
    const hits = files
      .map((f) => ({ file: rel(f), v: stripeEntryViolations(rel(f), fs.readFileSync(f, "utf8")) }))
      .filter((h) => h.v.length > 0);
    expect(hits).toEqual([]);
  });

  it("the panel is the one file that imports the pure entry and the React bindings", () => {
    const hits = files
      .filter((f) => {
        const s = fs.readFileSync(f, "utf8");
        return PURE_STRIPE_JS.test(s) || STRIPE_REACT.test(s);
      })
      .map(rel);
    expect(hits).toEqual([PANEL]);
  });

  it("the host reaches the panel only through dynamic(() => import(...)), never a static one", () => {
    const host = fs.readFileSync(path.join(WEB_ROOT, HOST), "utf8");
    expect(host).not.toMatch(/^import[^;]*from\s+["']\.\/EmbeddedCheckoutPanel["']/m);
    expect(host).toMatch(
      /dynamic\(\s*\n?\s*\(\)\s*=>\s*import\(\s*["']\.\/EmbeddedCheckoutPanel["']\s*\)/,
    );
  });
});

describe("Stripe entry pin self-controls (the scanner catches each way in)", () => {
  const LAYOUT = "app/(dashboard)/layout.tsx";

  it("a static import of the panel in the dashboard layout is caught (the reader's probe)", () => {
    const staticImport = ["static import of the panel"];
    expect(
      stripeEntryViolations(
        LAYOUT,
        'import { EmbeddedCheckoutPanel } from "@/components/billing/EmbeddedCheckoutPanel";',
      ),
    ).toEqual(staticImport);
    expect(stripeEntryViolations(LAYOUT, 'import "./EmbeddedCheckoutPanel";')).toEqual(
      staticImport,
    );
    expect(
      stripeEntryViolations(LAYOUT, 'export * from "../billing/EmbeddedCheckoutPanel.tsx";'),
    ).toEqual(staticImport);
    expect(
      stripeEntryViolations(
        LAYOUT,
        'const P = require("@/components/billing/EmbeddedCheckoutPanel");',
      ),
    ).toEqual(staticImport);
  });

  it("a dynamic import of the panel is allowed only in the host", () => {
    const dyn = 'const P = dynamic(() => import("./EmbeddedCheckoutPanel"), { ssr: false });';
    expect(stripeEntryViolations(HOST, dyn)).toEqual([]);
    expect(stripeEntryViolations(LAYOUT, dyn)).toEqual([
      "dynamic import of the panel outside the host",
    ]);
  });

  it.each([
    ["the bare entry", 'import { loadStripe } from "@stripe/stripe-js";'],
    ["a deep path", 'import { loadStripe } from "@stripe/stripe-js/dist/stripe.esm.js";'],
    ["a template literal", "const m = await import(`@stripe/stripe-js`);"],
    ["a require", 'const s = require("@stripe/stripe-js");'],
    ["a single-quoted string", "const name = '@stripe/stripe-js';"],
  ])("the main entry as %s is caught anywhere", (_n, text) => {
    expect(stripeEntryViolations(PANEL, text)).toContain("main @stripe/stripe-js entry");
    expect(stripeEntryViolations(LAYOUT, text)).toContain("main @stripe/stripe-js entry");
  });

  it("only the exact /pure entry is allowed, and only in the panel", () => {
    const pure = 'import { loadStripe } from "@stripe/stripe-js/pure";';
    expect(stripeEntryViolations(PANEL, pure)).toEqual([]);
    expect(stripeEntryViolations(LAYOUT, pure)).toEqual(["Stripe code outside the panel"]);
    expect(
      stripeEntryViolations(PANEL, 'import { loadStripe } from "@stripe/stripe-js/pure/x";'),
    ).toContain("main @stripe/stripe-js entry");
  });

  it("the React bindings are allowed only in the panel", () => {
    const react = 'import { EmbeddedCheckout } from "@stripe/react-stripe-js";';
    expect(stripeEntryViolations(PANEL, react)).toEqual([]);
    expect(stripeEntryViolations(LAYOUT, react)).toEqual(["Stripe code outside the panel"]);
  });
});
