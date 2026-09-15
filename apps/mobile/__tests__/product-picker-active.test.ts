/**
 * B142 (train 2, cause-ruling.md §2/§3, D4; amended by the Fable train-2
 * fix round, item 1) — `product-picker-active.test.ts`
 *
 * `ProductPickerSheet` feeds sale/purchase/count lines from a manual
 * browse-and-tap flow that never filtered `isActive` on `useAdminProducts` —
 * unlike web's `SearchableProductPicker.tsx:117-122`, which filters the
 * query itself. Only the scan path was guarded (F30/R5); the tap path could
 * commit an archived SKU as a brand-new order line.
 *
 * The fix is an opt-in `activeOnly` prop (default false), not an
 * unconditional filter: stock-count, PO-receive, vendor-bill-scan, and the
 * variant-parent pickers (ProductForm / InlineCreateProductSheet) all need
 * the *unfiltered* catalog — archiving is post-sale, and those flows
 * legitimately reference an already-archived product. Only the
 * order/invoice/standing-order-template callers, where a tap commits a
 * brand-new line, pass `activeOnly`.
 *
 * Source-text spec, comment-stripped (style of `barcode-scanner-active.test.ts`):
 * nothing renders under mobile Jest, so this reads the component/caller text.
 */
import { readFileSync } from "fs";
import { join } from "path";

const MOBILE_ROOT = join(__dirname, "..");
const PICKER_PATH = join(MOBILE_ROOT, "components", "ProductPickerSheet.tsx");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function readSource(relPath: string): string {
  return stripComments(readFileSync(join(MOBILE_ROOT, relPath), "utf8"));
}

const source = readSource("components/ProductPickerSheet.tsx");

describe("ProductPickerSheet — archived products excluded from the tap list (B142)", () => {
  it("REG-B142-D the picker exposes an activeOnly prop that gates the isActive filter", () => {
    expect(source).toMatch(/activeOnly\s*=\s*false/);
    // 2026-09-14 (hunt-mobile-scan): the sheet moved off the `limit: 0`
    // fetch-all `useAdminProducts` onto the debounced, gateable
    // `useAdminProductSearch`. The LOCATOR moved with it; the assertion did
    // not — `isActive` must still be `activeOnly ? true : undefined`, which is
    // what B142 actually guarantees. A locator left pointing at the old hook
    // name would have matched nothing and failed (or, with a laxer regex,
    // passed vacuously) while saying nothing about archived rows.
    const queryMatch = source.match(/useAdminProductSearch<[^>]*>\(\{[\s\S]*?\}\)/);
    expect(queryMatch).toBeTruthy();
    const queryBlock = queryMatch ? queryMatch[0] : "";
    expect(queryBlock).toMatch(/isActive:\s*activeOnly\s*\?\s*true\s*:\s*undefined/);
  });

  it("REG-B142-D order/invoice/standing-order callers pass activeOnly", () => {
    const orderCallers = [
      "app/(operator)/(tabs)/orders/[id]/edit-items.tsx",
      "components/NewOrderScreen.tsx",
      "app/(operator)/(tabs)/invoices/new.tsx",
      "app/(operator)/(tabs)/invoices/[id]/edit.tsx",
      "app/(operator)/customers/[id]/standing-orders/new.tsx",
    ];
    for (const rel of orderCallers) {
      const callerSrc = readSource(rel);
      const pickerMatch = callerSrc.match(/<ProductPickerSheet[\s\S]*?\/>/);
      expect(pickerMatch).toBeTruthy();
      expect(pickerMatch![0]).toMatch(/\bactiveOnly\b/);
    }
  });

  it("REG-B142-D the stock-count caller does NOT pass activeOnly (archived items are countable)", () => {
    const callerSrc = readSource("app/(operator)/products/stock-count/[id].tsx");
    const pickerMatches = callerSrc.match(/<ProductPickerSheet[\s\S]*?\/>/g) ?? [];
    expect(pickerMatches.length).toBeGreaterThan(0);
    for (const block of pickerMatches) {
      expect(block).not.toMatch(/\bactiveOnly\b/);
    }
  });

  it("keeps the Archived badge for a value already on the order", () => {
    // The badge stays even though the filtered query mostly makes it dead —
    // a stale/cached result or an id already selected before archival can
    // still surface here, and it must still be labelled, not silently sold.
    expect(source).toMatch(/isActive === false/);
    expect(source).toMatch(/Archived/);
  });
});
