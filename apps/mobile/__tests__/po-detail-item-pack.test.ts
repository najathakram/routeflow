/**
 * #2066 review round: the PO detail screen's pack/unit split must resolve at the LINE's OWN
 * stored `packSize` first — the live product's `unitsPerBox` is only the fallback for a line
 * that never stored one. Reading the live product ALONE (the pre-fix bug) shows no split once
 * a boxed product is edited to non-boxed, and re-denominates an already-received line's split
 * the moment the product is repacked — the same class of bug B707/#1171 fixed for invoice/
 * order lines. `linePack` (the shared resolver, `@routeflow/pricing`) is exercised here with
 * realistic PO-item shapes so a revert of the SCREEN's wiring to `item.product?.unitsPerBox`
 * directly is a real regression these cases would have caught, not just a formatting change —
 * `__tests__/po-detail-unit-display-wiring.test.ts` source-pins that the screen actually calls
 * it this way.
 */
import { linePack } from "@routeflow/pricing";

describe("PO detail item pack resolution (linePack, stored wins)", () => {
  it("stored 12 / live 6: the stored pack wins — a repack to 6 never re-denominates this line", () => {
    const item = { packSize: 12 };
    expect(linePack(item, 6)).toBe(12);
  });

  it("stored 12 / live null: the stored pack still wins with no live product to fall back to", () => {
    const item = { packSize: 12 };
    expect(linePack(item, 0)).toBe(12);
  });

  it("stored null -> live: no stored pack falls back to the live product's unitsPerBox", () => {
    const item = { packSize: null };
    expect(linePack(item, 6)).toBe(6);
  });

  it("stored 1 -> live: a stored pack of exactly 1 is not boxed, so live still wins", () => {
    const item = { packSize: 1 };
    expect(linePack(item, 6)).toBe(6);
  });

  it("stored null / live null: neither carries a pack — not boxed", () => {
    const item = { packSize: null };
    expect(linePack(item, 0)).toBe(0);
  });
});
