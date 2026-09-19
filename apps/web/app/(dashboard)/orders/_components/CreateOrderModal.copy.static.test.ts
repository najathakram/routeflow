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
 *
 * PR #933 extracted the line-item JSX carrying this copy out of
 * `CreateOrderModal.tsx` into the shared `apps/web/components/LineItemRow.tsx`
 * component (both placeholder occurrences + the toggle label moved there
 * intact; verified by reading both files, not just re-counting to make this
 * pass). Per lesson L-205 (assertions pinned to raw source text break on
 * refactors and pass on behavioural regressions), this pin now sums
 * occurrences across a candidate-file SET instead of one hard-coded path, so
 * a future move of this JSX between these files won't need this test edited
 * again, and the guard still catches the copy actually vanishing.
 */
import { readFileSync } from "fs";
import { join } from "path";

const CANDIDATE_PATHS = [
  join(__dirname, "CreateOrderModal.tsx"),
  join(__dirname, "..", "..", "..", "..", "components", "LineItemRow.tsx"),
];

function countOccurrencesAcrossCandidates(needle: string): number {
  return CANDIDATE_PATHS.reduce((total, path) => {
    const source = readFileSync(path, "utf8");
    return total + (source.split(needle).length - 1);
  }, 0);
}

describe("pin: CreateOrderModal/LineItemRow line-note copy (R5.5)", () => {
  it('shows the new placeholder "Flavor or note for this item (prints on invoice)" for both the catalog and custom line inputs', () => {
    expect(
      countOccurrencesAcrossCandidates(
        'placeholder="Flavor or note for this item (prints on invoice)"',
      ),
    ).toBe(2);
  });

  it('shows the new toggle label "Add flavor / note" at the single shared noteOpen toggle site', () => {
    expect(countOccurrencesAcrossCandidates("Add flavor / note")).toBe(1);
  });

  it('no longer shows the old placeholder copy "Note for this line"', () => {
    expect(countOccurrencesAcrossCandidates("Note for this line")).toBe(0);
  });
});
