/**
 * WP5 / T3 (R5.5) — source-text pin for the web `CreateOrderModal` per-line
 * note copy relabel, matching R5.1's mobile relabel. Copy-only, no
 * behaviour change — mirrors the convention of `print-surfaces.static.test.ts`.
 *
 * Ruling WP5 gives the exact relabel: both line-item note-input placeholders
 * (catalog line + custom/unlisted line) become "Flavor or note for this item
 * (prints on invoice)", and both `noteOpen` toggle labels (the single
 * shared `title={...}` ternary at the `:564`-pattern toggle site) become
 * "Add flavor / note". D-A5 (spec §10) confirms no existing test currently
 * pins the old "Add note" copy, so this is a clean new pin.
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

  it('shows the new toggle label "Add flavor / note" at least twice (both noteOpen toggle labels)', () => {
    expect(countOccurrences(src, "Add flavor / note")).toBeGreaterThanOrEqual(2);
  });

  it('no longer shows the old placeholder copy "Note for this line"', () => {
    expect(countOccurrences(src, "Note for this line")).toBe(0);
  });
});
