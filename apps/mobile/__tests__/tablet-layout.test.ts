import { readFileSync } from "fs";
import { join } from "path";
import {
  CONTENT_MAX_WIDTH,
  WIDE_CONTENT_MAX_WIDTH,
  contentWidth,
  gridColumns,
  isTabletWidth,
} from "../lib/tablet-layout";

// #2311 PR 1: the shared iPad width rule. Window widths in points: iPhone 16 390, iPad mini 744,
// iPad Pro 11" 834 (portrait) / 1210 (landscape), iPad Pro 13" 1032 (portrait) / 1376 (landscape).
describe("tablet-layout (#2311)", () => {
  it.each([
    [390, false, 1, 390],
    [744, true, 2, 744], // narrower than the cap: full width, still 2 columns
    [834, true, 2, CONTENT_MAX_WIDTH],
    [1032, true, 2, CONTENT_MAX_WIDTH],
    [1210, true, 3, CONTENT_MAX_WIDTH],
    [1376, true, 3, CONTENT_MAX_WIDTH],
  ])("width %i: tablet %s, %i columns, column content %i", (w, tablet, cols, content) => {
    expect(isTabletWidth(w)).toBe(tablet);
    expect(gridColumns(w)).toBe(cols);
    expect(contentWidth(w)).toBe(content);
  });

  it("a phone is never capped — the wrapper is a no-op there", () => {
    expect(contentWidth(390)).toBe(390);
    expect(contentWidth(390, "wide")).toBe(390);
  });

  it("the wide variant caps later than the reading column", () => {
    expect(contentWidth(1376, "wide")).toBe(WIDE_CONTENT_MAX_WIDTH);
    expect(WIDE_CONTENT_MAX_WIDTH).toBeGreaterThan(CONTENT_MAX_WIDTH);
  });

  it("ContentWidth applies exactly these caps, centred", () => {
    const src = readFileSync(join(__dirname, "../components/ContentWidth.tsx"), "utf8");
    expect(src).toMatch(
      /maxWidth: variant === "wide" \? WIDE_CONTENT_MAX_WIDTH : CONTENT_MAX_WIDTH/,
    );
    expect(src).toMatch(/alignSelf: "center"/);
  });
});
