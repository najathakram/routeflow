/**
 * REG-B741 (SA-1167 R5): the scan tray priced a unit-sold cart line at the PACK price. The wrong value is
 * 2 Cases at the pack's $24 tier price ($48), not 2 Cases at the Case's own $220 ($440). Both tray callers
 * (the create screen and the edit-items draft) must price by the line's own unit.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { lineUnitFor } from "../lib/cart-order-total";
import { draftTrayRows, type DraftItem } from "../lib/edit-items-draft";
import { trayRowsFrom, type TrayProduct } from "../lib/scan-tray";

const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");

const PRODUCT: TrayProduct = { id: "p-acme", name: "Acme widget", unitsPerBox: 24 };
// The shape lineUnitFor reads off a product: tier-1 pack price $24.
const FULL = { ...PRODUCT, pricePerUnit: 24, unit: "Box" } as never;

describe("scan tray prices a unit-sold line by its own unit", () => {
  it("REG-B741: the create-screen tray row (priceFor = lineUnitFor) totals 2 Cases at the Case price, not the pack price", () => {
    const line = {
      qty: 2,
      unitLabel: "Case",
      unitBasePrice: 220,
      boxes: null,
      pieces: null,
    };
    const rows = trayRowsFrom({
      items: { "p-acme": line },
      scanOrder: ["p-acme"],
      lookup: () => PRODUCT,
      // NewOrderScreen's priceFor: lib's lineUnitFor on the line, never the pack tier price.
      priceFor: (p, l) => lineUnitFor(l as never, FULL, 1),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].subtotal).toBe(440);
    expect(rows[0].subtotal).not.toBe(48); // 2 x the pack's $24
    expect(rows[0].qty).toBe(2); // a COUNT, never re-split against the 24-pack
    expect(rows[0].unitsPerBox).toBeNull();
  });

  it("REG-B741: the edit-items draft tray row totals 2 Cases at the Case price, not the pack price", () => {
    const draft: Record<string, DraftItem> = {
      l1: {
        productId: "p-acme",
        qty: 2,
        unitsPerBox: 240,
        unitLabel: "Case",
        unitPrice: 220,
        unitBasePrice: 220,
        catalogPrice: 24,
        name: "Acme widget",
      },
    };
    const rows = draftTrayRows({ draft, unlisted: [], scanOrder: ["l1"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].subtotal).toBe(440);
    expect(rows[0].subtotal).not.toBe(48);
  });

  it("REG-B741: the draft tray's fallback price is the unit's own base, not the pack catalogPrice", () => {
    // The fallback is only reached when no line override applies; pin the callback itself.
    const src = read("lib", "edit-items-draft.ts");
    expect(src).toMatch(
      /priceFor: \(product\) => \{[\s\S]{0,200}unitPriceBase\(item, item\.catalogPrice\)/,
    );
  });

  it("REG-B741: the create screen's tray callback resolves the line's own price through lineUnitFor", () => {
    const src = read("components", "NewOrderScreen.tsx");
    expect(src).toMatch(
      /trayRowsFrom\(\{[\s\S]{0,400}priceFor: \(p\) => \{[\s\S]{0,200}lineUnitFor\(items\[p\.id\], full, effectiveTierFor\(p\.id\)\)/,
    );
  });
});
