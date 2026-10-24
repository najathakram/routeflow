/**
 * #2717 M4a-1 (SA-580, mobile): what a scan of a given LEVEL does to the ONE order line — the pure
 * seam NewOrderScreen.addOne (and the invoice / edit-items pickers) call. RED (M4a-1):
 * `addScannedLevelToLine` is not exported by lib/sale-line.ts yet (TypeError: ... is not a function),
 * and NewOrderScreen.addOne still takes `kind: "case" | "piece"`.
 */
import * as fs from "fs";
import * as path from "path";
import { formatQtySplit } from "@routeflow/pricing";
import * as saleLine from "../lib/sale-line";

const addScannedLevelToLine = (saleLine as any).addScannedLevelToLine as (
  prev: any,
  level: "BOX" | "UNIT",
  isBoxed: boolean,
  unitsPerBox: number,
) => { qty: number; boxes?: number | null; pieces?: number | null; unitPrice?: number };

const NEW = { qty: 0 };
const line = (boxes: number, pieces: number, upb = 12) => ({
  qty: boxes * upb + pieces,
  boxes,
  pieces,
});

describe("addScannedLevelToLine — R1 (the scanned level decides)", () => {
  it("UNIT on a new boxed line -> 0 boxes + 1 piece, qty 1", () => {
    expect(addScannedLevelToLine(NEW, "UNIT", true, 12)).toMatchObject({
      qty: 1,
      boxes: 0,
      pieces: 1,
    });
  });

  it("BOX on a new boxed line -> 1 box + 0 pieces, qty 12", () => {
    expect(addScannedLevelToLine(NEW, "BOX", true, 12)).toMatchObject({
      qty: 12,
      boxes: 1,
      pieces: 0,
    });
  });

  it("UNIT onto 1 box -> 1 box + 1 piece on the SAME line (qty 13); BOX onto it -> 2 boxes + 1 piece", () => {
    const withPiece = addScannedLevelToLine(line(1, 0), "UNIT", true, 12);
    expect(withPiece).toMatchObject({ qty: 13, boxes: 1, pieces: 1 });
    expect(addScannedLevelToLine(withPiece, "BOX", true, 12)).toMatchObject({
      qty: 25,
      boxes: 2,
      pieces: 1,
    });
  });

  it("the piece that completes a case rolls over: 1 box + 11 pieces + UNIT -> 2 boxes + 0 pieces (normalizeBoxesPieces)", () => {
    expect(addScannedLevelToLine(line(1, 11), "UNIT", true, 12)).toMatchObject({
      qty: 24,
      boxes: 2,
      pieces: 0,
    });
  });

  it("keeps the operator's price override and note (spread prev, like incrementLine)", () => {
    const prev = { ...line(1, 0), unitPrice: 9.5, note: "n" };
    expect(addScannedLevelToLine(prev, "UNIT", true, 12)).toMatchObject({
      unitPrice: 9.5,
      note: "n",
    });
  });
});

describe("addScannedLevelToLine — R4 (upb <= 1: today's shape, level ignored)", () => {
  it.each([["BOX"], ["UNIT"]] as const)(
    "%s on a plain product adds +1 qty with no split",
    (level) => {
      const out = addScannedLevelToLine({ qty: 2 }, level, false, 1);
      expect(out.qty).toBe(3);
      expect(out.boxes ?? null).toBeNull();
      expect(out.pieces ?? null).toBeNull();
    },
  );
});

describe("SA-595a R4 — a sku (BOX-level) hit at upb <= 1 adds today's plain +1 line", () => {
  it.each([
    ["upb 1", 1],
    ["upb null", null],
  ] as const)("%s: new line -> qty 1, no split; existing line merges +1", (_n, upb) => {
    const isBoxed = (upb ?? 1) > 1;
    const created = addScannedLevelToLine(NEW, "BOX", isBoxed, upb ?? 1);
    expect(created.qty).toBe(1);
    expect(created.boxes ?? null).toBeNull();
    expect(created.pieces ?? null).toBeNull();
    const merged = addScannedLevelToLine({ qty: 4, unitPrice: 3 }, "BOX", isBoxed, upb ?? 1);
    expect(merged).toMatchObject({ qty: 5, unitPrice: 3 });
    expect(merged.boxes ?? null).toBeNull();
    expect(merged.pieces ?? null).toBeNull();
  });
});

describe("no hidden quantity — after ANY scan the line text states its boxes AND pieces", () => {
  it("1 box + 1 piece renders both parts", () => {
    const l = addScannedLevelToLine(line(1, 0), "UNIT", true, 12);
    const text = formatQtySplit({
      qty: l.qty,
      boxes: l.boxes ?? 0,
      pieces: l.pieces ?? 0,
      boxLabel: "case",
    });
    expect(text).toMatch(/1 case/);
    expect(text).toMatch(/1 (pc|pcs|piece|pieces|unit|units)\b/i);
  });

  it("a lone piece (0 boxes + 1 piece) still states the piece, not an empty case count", () => {
    const l = addScannedLevelToLine(NEW, "UNIT", true, 12);
    const text = formatQtySplit({
      qty: l.qty,
      boxes: l.boxes ?? 0,
      pieces: l.pieces ?? 0,
      boxLabel: "case",
    });
    expect(text).toMatch(/1 (pc|pcs|piece|pieces|unit|units)\b/i);
  });
});

describe("NewOrderScreen.addOne honours the scanned level (wiring pin)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "components", "NewOrderScreen.tsx"),
    "utf8",
  );

  it("addOne takes a BOX|UNIT level and routes through addScannedLevelToLine", () => {
    expect(src).toMatch(/addOne\s*=\s*\([^)]*level[^)]*\)/);
    // #2865: the add is the pure applyAddToItems (lib/pending-unit-adapter), which calls addScannedLevelToLine
    expect(src).toContain("applyAddToItems");
    expect(
      fs.readFileSync(path.join(__dirname, "..", "lib", "pending-unit-adapter.ts"), "utf8"),
    ).toContain("addScannedLevelToLine(cur ?? { qty: 0 }, a.level");
  });

  it('no `"case" | "piece"` unit-kind plumbing is left in the screen', () => {
    expect(src).not.toMatch(/"case"\s*\|\s*"piece"/);
  });
});
