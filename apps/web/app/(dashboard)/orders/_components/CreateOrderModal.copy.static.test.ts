/**
 * WP5 / T3 (R5.5) — source-text pin for the web `CreateOrderModal` per-line
 * note copy relabel, matching R5.1's mobile relabel. Copy-only, no
 * behaviour change — mirrors the convention of `print-surfaces.static.test.ts`.
 *
 * Ruling WP5 gives the exact relabel: both line-item note-input placeholders
 * (catalog line + custom/unlisted line) become "Flavor or note for this item
 * (prints on invoice)". The toggle *label* has a single shared render site on
 * web (one `<button title="Add flavor / note">` serves both the catalog and
 * custom/unlisted line branches — unlike mobile's two separate
 * CartRow/UnlistedCartRow components), so it relabels to "Add flavor / note"
 * exactly once, not twice; see commit fc581139 for why the ternary that used
 * to make this count 2 was dead code. D-A5 (spec §10) confirms no existing
 * test currently pins the old "Add note" copy, so this is a clean new pin.
 */
import { readFileSync } from "fs";
import { join } from "path";

const MODAL_PATH = join(__dirname, "CreateOrderModal.tsx");

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe("pin: web CreateOrderModal line-note copy (R5.5)", () => {
  const src = readFileSync(MODAL_PATH, "utf8");

  it('shows the new placeholder "Flavor or note for this item (prints on invoice)" for both the catalog and custom line inputs', () => {
    expect(
      countOccurrences(src, 'placeholder="Flavor or note for this item (prints on invoice)"'),
    ).toBe(2);
  });

  it('shows the new toggle label "Add flavor / note" at the single shared noteOpen toggle site', () => {
    expect(countOccurrences(src, "Add flavor / note")).toBe(1);
  });

  it('no longer shows the old placeholder copy "Note for this line"', () => {
    expect(countOccurrences(src, "Note for this line")).toBe(0);
  });
});
