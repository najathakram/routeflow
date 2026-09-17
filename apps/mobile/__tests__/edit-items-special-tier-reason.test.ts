/**
 * B465 (Opus BLOCK item 2, client half, fix round 2) — a SPECIAL-tier line's
 * documented reason must be REQUIRED, never optional, before `PriceOverrideModal`
 * lets the operator apply a price change; matches the web reference and the
 * server's own refusal ("A reason is required to change a special-price line").
 *
 * `canEditPriceFor`/`canEditPrice` already exclude a SPECIAL-tier line from
 * BOTH the list branch's and the picker branch's price-edit affordance
 * entirely (RULINGS R2/R9) — this is defense-in-depth for any path that
 * reaches `PriceOverrideModal` regardless, and is what the two call sites now
 * both thread `isSpecial`/`isSpecialTierFor` into.
 *
 * Source-text spec in the style of `edit-items-scan-price.test.ts`: nothing
 * renders under mobile Jest, so this reads `edit-items.tsx` as text and pins
 * the wiring, never a rendered tree. Paths resolve from `__dirname`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const SCREEN_PATH = join(
  __dirname,
  "..",
  "app",
  "(operator)",
  "(tabs)",
  "orders",
  "[id]",
  "edit-items.tsx",
);
const source = readFileSync(SCREEN_PATH, "utf8");

describe("edit-items.tsx PriceOverrideModal — SPECIAL-tier reason required (B465)", () => {
  // Slice from the function's own start to the NEXT top-level `function`
  // declaration (`UnlistedDraftCard`) — robust regardless of how much nested
  // JSX/brace complexity sits inside, unlike a fixed-size or brace-counting
  // regex window that silently under-matches whenever the function grows.
  const modalStart = source.indexOf("function PriceOverrideModal(");
  const nextFnStart = source.indexOf("\nfunction ", modalStart + 1);
  const modalFnSrc =
    modalStart === -1
      ? ""
      : source.slice(modalStart, nextFnStart === -1 ? source.length : nextFnStart);

  it("REG-B465-1: PriceOverrideModal accepts an isSpecial prop", () => {
    expect(modalFnSrc).toMatch(/isSpecial\s*=\s*false/);
  });

  it("REG-B465-2: Apply is invalid when isSpecial and the reason is blank — never just newPrice > 0", () => {
    expect(modalFnSrc).toMatch(/reasonMissing\s*=\s*isSpecial\s*&&\s*reason\.trim\(\)\s*===\s*""/);
    expect(modalFnSrc).toMatch(/valid\s*=\s*newPrice\s*>\s*0\s*&&\s*!reasonMissing/);
  });

  it("REG-B465-3: the reason field's label/placeholder swap to a required state, never a hardcoded 'optional'", () => {
    expect(modalFnSrc).toMatch(/isSpecial \? "Reason \(required\)" : "Reason \(optional\)"/);
  });

  it("REG-B465-4: both PriceOverrideModal mounts pass isSpecial from a live tier lookup, never a bare true/false literal", () => {
    // A whole mount (item/isSpecial/onSave's multi-line body/onCancel) can run
    // well past any fixed char window — anchor on the OPENING few props
    // instead of trying to capture the closing `/>`.
    const mountStarts = [...source.matchAll(/<PriceOverrideModal\b/g)].map((m) => m.index!);
    expect(mountStarts.length).toBeGreaterThanOrEqual(2);
    for (const start of mountStarts) {
      const head = source.slice(start, start + 200);
      expect(head).toMatch(/isSpecial=\{/);
      // Never a bare boolean literal masquerading as a real check.
      expect(head).not.toMatch(/isSpecial=\{true\}/);
      expect(head).not.toMatch(/isSpecial=\{false\}/);
    }
  });

  it("REG-B465-5: the list branch passes isSpecialFor(priceEditItem.productId) — the SAME helper canEditPriceFor already uses to exclude SPECIAL lines from the affordance itself", () => {
    expect(source).toMatch(/isSpecial=\{isSpecialFor\(priceEditItem\.productId\)\}/);
  });

  it("REG-B465-6: ProductPicker forwards an isSpecialTierFor prop through to its own PriceOverrideModal mount", () => {
    const splitIndex = source.indexOf("function ProductPicker");
    const pickerSrc = source.slice(splitIndex === -1 ? 0 : splitIndex);
    expect(pickerSrc).toMatch(/isSpecialTierFor\?\s*:\s*\(productId: string\) => boolean/);
    const mountStart = pickerSrc.indexOf("<PriceOverrideModal");
    expect(mountStart).toBeGreaterThan(-1);
    const head = pickerSrc.slice(mountStart, mountStart + 200);
    expect(head).toMatch(
      /isSpecial=\{isSpecialTierFor \? isSpecialTierFor\(pickerPriceEditItem\.productId\) : false\}/,
    );
  });

  it("REG-B465-7: the list branch's <ProductPicker mount threads isSpecialTierFor={isSpecialFor} through — the picker's own modal must see the SAME tier truth as the list branch's", () => {
    const pickerMount = (source.match(/<ProductPicker\b[\s\S]{0,2000}?initialScanOpen=/) ?? [
      "",
    ])[0];
    expect(pickerMount).toMatch(/isSpecialTierFor=\{isSpecialFor\}/);
  });
});
