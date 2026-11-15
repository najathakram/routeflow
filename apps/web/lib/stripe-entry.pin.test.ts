import * as fs from "fs";
import * as path from "path";

/**
 * SA-1139 fix round 1 (MUST 1): the dashboard shell mounts the embedded-checkout host on every page, so no Stripe
 * code may load until a checkout is open. The main `@stripe/stripe-js` entry injects js.stripe.com at module load;
 * only the `/pure` entry is allowed, and only the lazy panel may import it (or the React bindings).
 */
const WEB_ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "coverage", "e2e", "playwright-report"]);

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

const rel = (f: string) => path.relative(WEB_ROOT, f).split(path.sep).join("/");
const bareStripeJs = /["']@stripe\/stripe-js["']/;
const stripeReact = /["']@stripe\/react-stripe-js["']/;
const pureStripeJs = /["']@stripe\/stripe-js\/pure["']/;

describe("Stripe entry pins (SA-1139)", () => {
  const files = sourceFiles(WEB_ROOT);

  it("no file under apps/web imports the bare @stripe/stripe-js entry", () => {
    const hits = files.filter((f) => bareStripeJs.test(fs.readFileSync(f, "utf8"))).map(rel);
    expect(hits).toEqual([]);
  });

  it("only the lazy panel imports the pure entry or the React bindings", () => {
    const hits = files
      .filter((f) => {
        const s = fs.readFileSync(f, "utf8");
        return pureStripeJs.test(s) || stripeReact.test(s);
      })
      .map(rel);
    expect(hits).toEqual(["components/billing/EmbeddedCheckoutPanel.tsx"]);
  });

  it("the host reaches the panel only through a lazy import, never a static one", () => {
    const host = fs.readFileSync(
      path.join(WEB_ROOT, "components/billing/EmbeddedCheckoutHost.tsx"),
      "utf8",
    );
    expect(host).not.toMatch(/^import[^;]*from\s+["']\.\/EmbeddedCheckoutPanel["']/m);
    expect(host).toMatch(/import\(\s*["']\.\/EmbeddedCheckoutPanel["']\s*\)/);
  });
});
