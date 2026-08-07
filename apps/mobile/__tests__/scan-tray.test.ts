/**
 * Split-view scan tray: the just-scanned line must be the FIRST row, and its
 * money must be the same money the builder footer already shows.
 */
import {
  bumpScanOrder,
  nextFlash,
  trayRowsFrom,
  type TrayLine,
  type TrayProduct,
} from "../lib/scan-tray";
import { computeLineSubtotal } from "../lib/pricing";

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
    expect(out[0].qtySummary).toBe("1 cs + 1");
  });

  it("drops the loose part when the boxed line is whole cases", () => {
    const out = rows({ case6: { qty: 12, boxes: 2, pieces: 0 } }, ["case6"]);
    expect(out[0].qtySummary).toBe("2 cs");
  });

  it("renders a plain count for a single-unit line", () => {
    const out = rows({ single: { qty: 4 } }, ["single"]);
    expect(out[0].qtySummary).toBe("4");
  });

  it("rolls a raw boxed qty into cases for the summary", () => {
    const out = rows({ case6: { qty: 7 } }, ["case6"]);
    expect(out[0].qtySummary).toBe("1 cs + 1");
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
});
