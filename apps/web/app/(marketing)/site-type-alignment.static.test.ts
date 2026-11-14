/**
 * Static companions to e2e/86-site-type-alignment.spec.ts for the two items whose fix lanes run
 * in wave 1b: T49 (signup terms line) and T53 (product hero columns). They read the source and
 * assert the declared value, so they can be seen red without a browser.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const WEB = path.resolve(__dirname, "..", "..");

describe("T49 companion: signup terms paragraph", () => {
  const src = fs.readFileSync(path.join(WEB, "app", "(auth)", "signup", "page.tsx"), "utf8");
  const m = /<p\s+className="([^"]*)">\s*By signing up you agree to our/.exec(src);
  const classes = m ? m[1].split(/\s+/) : [];

  it("is found", () => {
    expect(m).not.toBeNull();
  });

  it("is not centred", () => {
    expect(classes).not.toContain("text-center");
  });

  it("uses text-pretty so the last line is not a lone word", () => {
    expect(classes).toContain("text-pretty");
  });
});

describe("T53 companion: product hero columns", () => {
  const css = fs.readFileSync(path.join(WEB, "public", "site", "css", "product.css"), "utf8");
  // Drop the (max-width) media blocks: the one-column phone rule is separate.
  const desktop = css.replace(/@media[^{]*\(max-width[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const blocks = Array.from(desktop.matchAll(/\.pd-top-in\s*\{([^}]*)\}/g)).map((x) => x[1]);
  const values = blocks
    .map((b) => /align-items\s*:\s*([a-z-]+)/.exec(b))
    .filter((x): x is RegExpExecArray => x !== null)
    .map((x) => x[1]);

  it("has a desktop .pd-top-in rule", () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("aligns the columns at the top, not the centre", () => {
    expect(values).toContain("start");
    expect(values).not.toContain("center");
  });
});
