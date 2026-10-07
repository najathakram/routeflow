/**
 * Split-view scan tray: the just-scanned line must be the FIRST row, and its
 * money must be the same money the builder footer already shows.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  bumpScanOrder,
  nextFlash,
  trayRowsFrom,
  type TrayLine,
  type TrayProduct,
} from "../lib/scan-tray";
import { computeLineSubtotal } from "@routeflow/pricing";

const CASE_OF_6: TrayProduct = { id: "case6", name: "Acme Cola", unitsPerBox: 6 };
const SINGLE: TrayProduct = { id: "single", name: "Acme Chips", unitsPerBox: null };
const OTHER: TrayProduct = { id: "other", name: "Acme Water", unitsPerBox: null };
const catalog = new Map<string, TrayProduct>([
  [CASE_OF_6.id, CASE_OF_6],
  [SINGLE.id, SINGLE],
  [OTHER.id, OTHER],
]);
const lookup = (id: string) => catalog.get(id);
const priceFor = (p: TrayProduct) => (p.id === CASE_OF_6.id ? 12 : 2.5);

function rows(items: Record<string, TrayLine>, scanOrder: string[], unlisted = []) {
  return trayRowsFrom({ items, unlisted, scanOrder, lookup, priceFor });
}

describe("bumpScanOrder", () => {
  it("prepends an id that isn't in the order yet", () => {
    expect(bumpScanOrder(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  it("moves an existing id to the front without duplicating it", () => {
    expect(bumpScanOrder(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  it("preserves the relative order of the rest", () => {
    expect(bumpScanOrder(["a", "b", "c", "d"], "c")).toEqual(["c", "a", "b", "d"]);
  });

  it("returns the same array reference when the id is already first", () => {
    const order = ["a", "b"];
    expect(bumpScanOrder(order, "a")).toBe(order);
  });

  it("handles an empty order", () => {
    expect(bumpScanOrder([], "a")).toEqual(["a"]);
  });
});

describe("nextFlash", () => {
  it("increments the nonce so re-scanning the same item re-flashes", () => {
    const first = nextFlash(null, "a");
    expect(first).toEqual({ id: "a", nonce: 1 });
    expect(nextFlash(first, "a")).toEqual({ id: "a", nonce: 2 });
  });

  it("carries the nonce across a different id", () => {
    expect(nextFlash({ id: "a", nonce: 4 }, "b")).toEqual({ id: "b", nonce: 5 });
  });
});

describe("trayRowsFrom", () => {
  it("orders scanned lines newest-first", () => {
    const out = rows(
      { single: { qty: 1 }, other: { qty: 1 }, case6: { qty: 6, boxes: 1, pieces: 0 } },
      ["case6", "other", "single"],
    );
    expect(out.map((r) => r.id)).toEqual(["case6", "other", "single"]);
  });

  it("appends lines added before scan mode opened, in insertion order", () => {
    const out = rows({ single: { qty: 2 }, other: { qty: 1 }, case6: { qty: 6, boxes: 1 } }, [
      "case6",
    ]);
    expect(out.map((r) => r.id)).toEqual(["case6", "single", "other"]);
  });

  it("skips zero-qty lines", () => {
    const out = rows({ single: { qty: 0 }, other: { qty: 3 } }, ["other", "single"]);
    expect(out.map((r) => r.id)).toEqual(["other"]);
  });

  it("skips lines whose product hasn't loaded yet", () => {
    const out = rows({ ghost: { qty: 2 }, other: { qty: 1 } }, ["ghost", "other"]);
    expect(out.map((r) => r.id)).toEqual(["other"]);
  });

  it("includes unlisted lines", () => {
    const out = trayRowsFrom({
      items: { other: { qty: 1 } },
      unlisted: [{ id: "u1", name: "Pallet fee", qty: 2, unitPrice: 7.5 }],
      scanOrder: ["other"],
      lookup,
      priceFor,
    });
    expect(out.map((r) => r.id)).toEqual(["other", "u1"]);
    expect(out[1]).toMatchObject({
      name: "Pallet fee",
      qtySummary: "2",
      subtotal: 15,
      unlisted: true,
    });
  });

  it("renders a boxed qty summary in cases plus loose units", () => {
    // 7 units of a 6-pack -> 1 case + 1 loose.
    const out = rows({ case6: { qty: 7, boxes: 1, pieces: 1 } }, ["case6"]);
    expect(out[0].qtySummary).toBe("1 bx + 1");
  });

  it("drops the loose part when the boxed line is whole cases", () => {
    const out = rows({ case6: { qty: 12, boxes: 2, pieces: 0 } }, ["case6"]);
    expect(out[0].qtySummary).toBe("2 bx");
  });

  it("renders a plain count for a single-unit line", () => {
    const out = rows({ single: { qty: 4 } }, ["single"]);
    expect(out[0].qtySummary).toBe("4");
  });

  it("rolls a raw boxed qty into cases for the summary", () => {
    const out = rows({ case6: { qty: 7 } }, ["case6"]);
    expect(out[0].qtySummary).toBe("1 bx + 1");
  });

  it("prices a boxed line through the shared helper (loose units prorated)", () => {
    const line: TrayLine = { qty: 7, boxes: 1, pieces: 1 };
    const out = rows({ case6: line }, ["case6"]);
    expect(out[0].subtotal).toBe(
      computeLineSubtotal({ unitPrice: 12, qty: 7, boxes: 1, pieces: 1, unitsPerBox: 6 }),
    );
    expect(out[0].subtotal).toBe(14); // 12 x (1 + 1/6)
  });

  it("uses the per-line price override over the resolved tier price", () => {
    const out = rows({ single: { qty: 3, unitPrice: 1.99 } }, ["single"]);
    expect(out[0].subtotal).toBe(computeLineSubtotal({ unitPrice: 1.99, qty: 3 }));
  });

  it("ignores the override on non-overridable (SPECIAL tier) lines", () => {
    const out = trayRowsFrom({
      items: { single: { qty: 3, unitPrice: 1.99 }, other: { qty: 2, unitPrice: 1.0 } },
      scanOrder: ["single", "other"],
      lookup,
      priceFor,
      overridable: (p) => p.id !== "single",
    });
    // single is SPECIAL: charges the tier price, not the stale override.
    expect(out[0].subtotal).toBe(computeLineSubtotal({ unitPrice: 2.5, qty: 3 }));
    // other stays overridable.
    expect(out[1].subtotal).toBe(computeLineSubtotal({ unitPrice: 1.0, qty: 2 }));
  });

  it("sums to the same total the footer computes over the same lines", () => {
    const items: Record<string, TrayLine> = {
      case6: { qty: 7, boxes: 1, pieces: 1 },
      single: { qty: 3, unitPrice: 1.99 },
      other: { qty: 2 },
    };
    const out = rows(items, ["single", "case6"]);
    const footer = Object.entries(items).reduce((sum, [id, line]) => {
      const p = catalog.get(id)!;
      return (
        sum +
        computeLineSubtotal({
          unitPrice: line.unitPrice != null ? line.unitPrice : priceFor(p),
          qty: line.qty,
          boxes: line.boxes ?? null,
          pieces: line.pieces ?? null,
          unitsPerBox: p.unitsPerBox ?? null,
        })
      );
    }, 0);
    expect(out.reduce((sum, r) => sum + r.subtotal, 0)).toBe(footer);
  });

  it("composes a variant's display name from its parent", () => {
    const variant: TrayProduct = {
      id: "v1",
      name: "Cherry",
      parentProductId: "p1",
      parent: { name: "Acme Cola" },
    };
    const out = trayRowsFrom({
      items: { v1: { qty: 1 } },
      scanOrder: ["v1"],
      lookup: (id) => (id === "v1" ? variant : undefined),
      priceFor: () => 3,
    });
    expect(out[0].name).toBe("Acme Cola - Cherry");
  });

  describe("freeUnitsFor (REG-shared-a2)", () => {
    it("REG-shared-a2-01: without freeUnitsFor, subtotal is byte-identical to today", () => {
      // Same boxed line as the "prices a boxed line" case above, with no
      // freeUnitsFor supplied at all — the omitted-field default path.
      const line: TrayLine = { qty: 7, boxes: 1, pieces: 1 };
      const out = trayRowsFrom({ items: { case6: line }, scanOrder: ["case6"], lookup, priceFor });
      expect(out[0].subtotal).toBe(
        computeLineSubtotal({ unitPrice: 12, qty: 7, boxes: 1, pieces: 1, unitsPerBox: 6 }),
      );
      expect(out[0].subtotal).toBe(14);
    });

    it("REG-shared-a2-02: with freeUnitsFor returning n, subtotal nets n free units via computeLineSubtotal", () => {
      const line: TrayLine = { qty: 12, boxes: 2, pieces: 0 };
      const out = trayRowsFrom({
        items: { case6: line },
        scanOrder: ["case6"],
        lookup,
        priceFor,
        freeUnitsFor: () => 1,
      });
      expect(out[0].subtotal).toBe(
        computeLineSubtotal({
          unitPrice: 12,
          qty: 12,
          boxes: 2,
          pieces: 0,
          unitsPerBox: 6,
          freeUnits: 1,
        }),
      );
      // Sanity: the free unit actually changed the price versus the no-promo case.
      expect(out[0].subtotal).not.toBe(
        computeLineSubtotal({ unitPrice: 12, qty: 12, boxes: 2, pieces: 0, unitsPerBox: 6 }),
      );
    });

    it("REG-shared-a2-03: freeUnitsFor receives the id and the line", () => {
      const seen: Array<{ id: string; line: TrayLine }> = [];
      const line: TrayLine = { qty: 3, unitPrice: 1.99 };
      trayRowsFrom({
        items: { single: line },
        scanOrder: ["single"],
        lookup,
        priceFor,
        freeUnitsFor: (id, l) => {
          seen.push({ id, line: l });
          return 0;
        },
      });
      expect(seen).toEqual([{ id: "single", line }]);
    });
  });

  /**
   * SA-085h HIGH: a unit-sold line's qty is a COUNT of `unitLabel`, never pieces-in-a-box.
   * `priceFor` now receives the line too, so a caller can price it off its OWN resolved
   * level instead of the pack's tier price (the shipped bug: a Case line has no unitPrice,
   * so `priceFor(product)` alone returned the pack's price for a $220 Case).
   */
  describe("units_v1 — a unit-sold line's qty/price never fold against the pack (SA-085h HIGH)", () => {
    // A unit-aware `priceFor` mirrors lineUnitFor/unitPriceBase: it resolves off the LINE's
    // own unitLabel, never the pack's tier price, for a unit-sold line ($220/Case here).
    const unitAwarePriceFor = (p: TrayProduct, line: TrayLine) =>
      line.unitLabel ? 220 : priceFor(p);

    it("2 Cases at $220 total $440 in the tray, never $48 (2 x the pack's own price)", () => {
      const out = trayRowsFrom({
        items: { case6: { qty: 2, unitLabel: "Case" } },
        scanOrder: ["case6"],
        lookup,
        priceFor: unitAwarePriceFor,
      });
      expect(out[0].subtotal).toBe(440);
      expect(out[0].subtotal).not.toBe(48);
    });

    it("RED PROOF: a priceFor that ignores the line (the shipped shape) prices the Case at the pack's price, not $440", () => {
      const out = trayRowsFrom({
        items: { case6: { qty: 2, unitLabel: "Case" } },
        scanOrder: ["case6"],
        lookup,
        priceFor: (p: TrayProduct) => priceFor(p), // old signature: no line, no unit-awareness
      });
      expect(out[0].subtotal).toBe(24); // 2 x $12, case6's own pack-price fixture — the shipped bug
      expect(out[0].subtotal).not.toBe(440); // the fixed behaviour, proven above
    });

    it("a unit-sold line's qty never gets re-split against the pack's unitsPerBox", () => {
      const out = trayRowsFrom({
        items: { case6: { qty: 2, unitLabel: "Case" } },
        scanOrder: ["case6"],
        lookup,
        priceFor: unitAwarePriceFor,
      });
      expect(out[0].qtySummary).toBe("2"); // never "0 cs + 2" or similar
      expect(out[0].unitsPerBox).toBeNull();
      expect(out[0].qty).toBe(2);
    });
  });
});

/**
 * Source-text pin for `components/ScanTray.tsx`'s optional price-edit
 * affordance (seed2-scan-tray-has-no-price-control). Mobile Jest is
 * `testEnvironment: "node"` (jest.config.js) with no React renderer, so this
 * reads the component as text rather than mounting it — the style of
 * `edit-items-scan-price.test.ts`.
 */
describe("ScanTray.tsx price-edit affordance (REG-shared-scantray-price)", () => {
  const SCAN_TRAY_PATH = join(__dirname, "..", "components", "ScanTray.tsx");
  const scanTraySrc = readFileSync(SCAN_TRAY_PATH, "utf8");

  it("REG-shared-scantray-price-01: ScanTrayProps declares an optional onEditPrice", () => {
    expect(scanTraySrc).toMatch(/onEditPrice\?:\s*\(id:\s*string\)\s*=>\s*void/);
  });

  it("REG-shared-scantray-price-02: the row renders a tappable price affordance only when onEditPrice is supplied", () => {
    // Guarded by the prop, not rendered unconditionally.
    expect(scanTraySrc).toMatch(/onEditPrice\s*\?\s*\(/);
    // The affordance is a real press target with the exact accessibility
    // contract the design calls for.
    expect(scanTraySrc).toMatch(/accessibilityRole="button"/);
    expect(scanTraySrc).toMatch(/accessibilityLabel=\{`Edit price for \$\{name\}`\}/);
  });

  it("REG-shared-scantray-price-03: onEditPrice is threaded from ScanTray down to the row item", () => {
    expect(scanTraySrc).toMatch(/onEditPrice,?\s*\}:\s*RowProps/);
    // renderItem passes it through and lists it as a memo dependency.
    expect(scanTraySrc).toMatch(/onEditPrice=\{onEditPrice\}/);
    // #2694 appended the optional hideMoney to the same memo deps.
    expect(scanTraySrc).toMatch(
      /\[flash, reduceMotion, onChangeQty, onIncrement, onDecrement, onRemove, onEditPrice(, hideMoney)?\]/,
    );
  });
});

/**
 * Source-text pin for `packages/ui/src/mobile/ios/SearchBar.tsx` forwarding
 * `autoFocus` and exposing a ref, in the same read-as-text style (no renderer
 * under mobile Jest).
 */
describe("SearchBar.tsx autoFocus + forwardRef (REG-shared-searchbar-autofocus)", () => {
  const SEARCH_BAR_PATH = join(
    __dirname,
    "..",
    "..",
    "..",
    "packages",
    "ui",
    "src",
    "mobile",
    "ios",
    "SearchBar.tsx",
  );
  const searchBarSrc = readFileSync(SEARCH_BAR_PATH, "utf8");

  it("REG-shared-searchbar-autofocus-01: SearchBarProps declares an optional autoFocus", () => {
    expect(searchBarSrc).toMatch(/autoFocus\?:\s*boolean/);
  });

  it("REG-shared-searchbar-autofocus-02: the underlying TextInput receives autoFocus", () => {
    expect(searchBarSrc).toMatch(/autoFocus=\{autoFocus\}/);
  });

  it("REG-shared-searchbar-autofocus-03: SearchBar is wrapped in React.forwardRef<TextInput, SearchBarProps>", () => {
    expect(searchBarSrc).toMatch(/React\.forwardRef<TextInput,\s*SearchBarProps>/);
    expect(searchBarSrc).toMatch(/<TextInput\s*\n\s*ref=\{ref\}/);
  });
});
