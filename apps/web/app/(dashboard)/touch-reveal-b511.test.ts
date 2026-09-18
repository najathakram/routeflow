import fs from "fs";
import path from "path";

/**
 * B511 (C2 390px audit): four row/overlay actions were gated purely on
 * `opacity-0 group-hover:opacity-100`, which never reveals on touch since
 * `:hover` doesn't fire there — the control read as absent. jsdom can't
 * evaluate `@media (hover: none)` (no layout/media-query engine), so this
 * pins the source-level facts a browser check can't regress silently: the
 * shared `.touch-reveal` utility exists, is declared outside any `@layer`
 * (so it always wins the cascade over the layered Tailwind utilities
 * regardless of generation order), and every hover-reveal call site now
 * carries it.
 */
function read(relPath: string): string {
  return fs.readFileSync(path.join(__dirname, relPath), "utf8");
}

/** Returns the substring inside the first balanced-brace block opening at `startIndex`. */
function braceBlockBody(css: string, startIndex: number): string {
  const openIndex = css.indexOf("{", startIndex);
  let depth = 0;
  for (let i = openIndex; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(openIndex + 1, i);
    }
  }
  throw new Error("unbalanced braces");
}

describe("B511 — hover-reveal row actions stay visible on touch", () => {
  it("globals.css declares .touch-reveal unlayered, forcing opacity 1 under (hover: none)", () => {
    const css = read("../globals.css");
    const layerStart = css.indexOf("@layer utilities");
    expect(layerStart).toBeGreaterThan(-1);
    const layerBody = braceBlockBody(css, layerStart);
    expect(layerBody).not.toContain(".touch-reveal");

    const match = css.match(/@media \(hover: none\) \{\s*\.touch-reveal \{\s*opacity: 1;/);
    expect(match).not.toBeNull();
    // and it must actually sit outside the utilities layer body found above
    expect(css.indexOf(match![0])).toBeGreaterThan(layerStart + layerBody.length);
  });

  it("invoices payment-history Edit/Delete carry touch-reveal", () => {
    const src = read("invoices/[id]/page.tsx");
    expect(src).toContain(
      'className="touch-reveal rounded p-1 text-navy/30 opacity-0 transition-all group-hover:opacity-100 hover:text-brand-500"',
    );
    expect(src).toContain(
      'className="touch-reveal rounded p-1 text-navy/30 opacity-0 transition-all group-hover:opacity-100 hover:text-danger"',
    );
  });

  it("customers document delete, tax-doc overlay, and tag-remove carry touch-reveal", () => {
    const src = read("customers/[id]/page.tsx");
    expect(src).toContain(
      'className="touch-reveal absolute right-2 top-2 rounded-full bg-white/90 p-1.5 text-navy/70 opacity-0 shadow transition hover:text-danger group-hover:opacity-100"',
    );
    expect(src).toContain(
      'className="touch-reveal absolute inset-0 flex items-center justify-center gap-1.5 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100"',
    );
    expect(src).toContain(
      'className="touch-reveal rounded-full p-0.5 opacity-0 transition-opacity hover:bg-black/10 group-hover:opacity-100"',
    );
  });
});
