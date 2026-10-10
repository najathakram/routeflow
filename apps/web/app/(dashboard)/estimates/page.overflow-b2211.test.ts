import fs from "fs";
import path from "path";

/**
 * #2211 (3): the estimates list table sat inside a bare `overflow-hidden` card, so from 320px to
 * 430px it clipped instead of scrolling (+41 to +151px past the viewport). Same fix as the
 * invoices list (B750): an inner `overflow-x-auto` wrapper around the `<table>`, with the outer
 * card keeping `overflow-hidden` only for its rounded corners. This pins the wiring; the
 * 320-430px proof is a Playwright capture.
 */
const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("#2211 — estimates list table scrolls instead of clipping", () => {
  it("wraps every <table> in an overflow-x-auto div directly inside the overflow-hidden card", () => {
    const tables = src.match(/<table\b/g) ?? [];
    expect(tables.length).toBeGreaterThan(0);
    expect(
      src.match(
        /<div className="overflow-hidden rounded-lg border border-surface-border">\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<div className="overflow-x-auto">\s*<table\b/g,
      ) ?? [],
    ).toHaveLength(tables.length);
  });
});
