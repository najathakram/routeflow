/**
 * WP5 / T2 (R5.1) — source-text pin for the mobile new-order per-line note
 * copy relabel. Source-text pin (the RN component can't be rendered under the
 * mobile Jest env, which is pure-logic/node only — see jest.config.js)
 * mirroring the convention of `invoice-print-tile.pins.test.ts`.
 *
 * Ruling WP5 gives the exact old→new string swap: the toggle label becomes
 * "Add flavor / note" and the placeholder becomes "Flavor or note for this
 * item (prints on invoice)", for both `CartRow` and `UnlistedCartRow`.
 *
 * `CartRow` moved to its own file (`components/CartRow.tsx`) in the units_v1
 * picker work (size-ratchet prefactor) — this pin now reads both files
 * instead of assuming a single source, since `UnlistedCartRow` stayed behind
 * in NewOrderScreen.tsx and `CartRow` did not. #2339 then moved `UnlistedCartRow`
 * (with CartModal) to `components/new-order/CartModal.tsx`, so the pin reads that file too.
 */
import { readFileSync } from "fs";
import { join } from "path";

const SCREEN_PATH = join(__dirname, "..", "components", "NewOrderScreen.tsx");
const CART_ROW_PATH = join(__dirname, "..", "components", "CartRow.tsx");
const CART_MODAL_PATH = join(__dirname, "..", "components", "new-order", "CartModal.tsx");

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe("pin: mobile new-order line-note copy (R5.1)", () => {
  const src =
    readFileSync(SCREEN_PATH, "utf8") +
    readFileSync(CART_ROW_PATH, "utf8") +
    readFileSync(CART_MODAL_PATH, "utf8");

  it('shows the new toggle label "Add flavor / note" for both CartRow and UnlistedCartRow', () => {
    expect(countOccurrences(src, ">Add flavor / note<")).toBe(2);
  });

  it('shows the new placeholder "Flavor or note for this item (prints on invoice)" for both rows', () => {
    expect(
      countOccurrences(src, 'placeholder="Flavor or note for this item (prints on invoice)"'),
    ).toBe(2);
  });

  it('no longer shows the old toggle label "Add note"', () => {
    expect(countOccurrences(src, ">Add note<")).toBe(0);
  });

  it('no longer shows the old placeholder copy "Note for this item"', () => {
    expect(countOccurrences(src, "Note for this item")).toBe(0);
  });
});
