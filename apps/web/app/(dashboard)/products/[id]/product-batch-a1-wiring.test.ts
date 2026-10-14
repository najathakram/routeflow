import * as fs from "fs";
import * as path from "path";

/**
 * Batch A1 (product detail "reach the action"): page.tsx is ~2.8k lines, so these class/copy-level
 * items are pinned on the source, the same way family-detail-wiring.test.ts does.
 */
const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("products/[id]/page.tsx — batch A1 wiring", () => {
  it("P-03: the hero dropzone is 176px tall below lg, 4:5 from lg", () => {
    expect(src).toMatch(/"relative h-44 w-full[^"]*lg:h-auto lg:aspect-\[4\/5\]"/);
    expect(src).not.toMatch(/"relative aspect-\[4\/5\]/);
  });

  it("P-03: thumbnails use the fallback component (no bare 'thumb N' alt)", () => {
    expect(src).toMatch(/<ThumbImage/);
    expect(src).not.toContain("alt={`thumb ${i + 1}`}");
  });

  it("P-02: edit mode mounts the sticky bar and pads the wrapper", () => {
    expect(src).toMatch(/\{isEditing && \(\s*<StickyEditBar/);
    expect(src).toMatch(/isEditing && "pb-24 md:pb-6"/);
  });

  it("P-17: saveEdit confirms with a Saved toast and scrolls the Details card into view", () => {
    expect(src).toMatch(/toast\(\{ title: "Saved", variant: "success" \}\)/);
    expect(src).toMatch(/scrollCardIntoView\(detailsCardRef\.current\)/);
    expect(src).toMatch(/ref=\{detailsCardRef\}/);
  });

  it("P-17: the merch switches say they apply immediately while editing", () => {
    expect(src).toMatch(
      /isEditing && \(\s*<p className="[^"]*">\s*These switches apply immediately, without Save\./,
    );
  });

  it("J3 reverted: the Move left / Move right reorder controls stay (the only reorder path); on-image arrows stay", () => {
    expect(src).toContain('title="Move left"');
    expect(src).toContain('title="Move right"');
    expect(src).toContain("Prev / next arrows");
  });

  it("J7: the Details 'Variant of' row shows only while editing", () => {
    expect(src).toMatch(/\{isEditing && \(\s*<InfoRow\s+label="Variant of"/);
    expect(src).not.toContain("(isEditing || product.parentProductId)");
  });
});
