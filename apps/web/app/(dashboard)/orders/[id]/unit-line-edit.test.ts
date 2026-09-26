/**
 * A3-2 (bug-hunt finding, tracked on #938): the web staff order-edit page had no `unitLabel`
 * handling at all — editing a unit-aware ("Case") line's qty/price sent `{id, qty, boxes, pieces}`
 * (the pack-line shape), which the server refuses with 409 UNIT_AWARE_LINE
 * (`unit-line-edit.ts` `assertUnitLabelNamed`) since it never named the unit.
 *
 * These pin the payload builders directly (no full page render — see
 * `EditableLineItems.unit-picker.test.tsx` for the picker-mounting behavior), with OBSERVED
 * expected outputs traced against the pre-fix code (see PR body): the old inline seeding read
 * `li.qty` (base pieces, e.g. 576 for 3 Cases of 192) straight into `EditItemState.qty` with no
 * `unitLabel` field at all, so editing "3 -> 4" produced `{id, action:"UPDATE", qty:768,
 * boxes:4, pieces:0}` (pieces re-expanded from a piece-denominated qty) — never `unitLabel`, and
 * qty itself wrong by a factor of unitsPerBox.
 */
import {
  buildEditItemFromLine,
  buildItemUpdates,
  editLineFreeUnits,
  type EditItemState,
} from "./page";
import {
  findLockedUnitLineEdit,
  LockedUnitLineError,
  unitLineCount,
} from "./_components/unit-line-lock";
import type { OrderItem, ItemUpdate } from "@/lib/api/orders";

function unitLine(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: "li-case",
    productId: "p-case",
    product: { id: "p-case", name: "Widget", unit: "Box", unitsPerBox: 192 },
    qty: 576, // 3 Cases * 192 pieces/Case — the server's base-piece total
    unitPrice: 40, // price PER CASE
    boxes: 3, // the CASE COUNT (unit-line-build.ts convention — never a physical box here)
    pieces: 0,
    unitsPerBox: 192, // the snapshotted FACTOR
    unitLabel: "Case",
    status: "CONFIRMED",
    ...overrides,
  };
}

function plainBoxedLine(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: "li-plain",
    productId: "p-plain",
    product: { id: "p-plain", name: "Gadget", unit: "Box", unitsPerBox: 12 },
    qty: 36, // 3 boxes * 12
    unitPrice: 9.99, // price PER BOX
    boxes: 3,
    pieces: 0,
    unitsPerBox: 12,
    status: "CONFIRMED",
    ...overrides,
  };
}

describe("buildEditItemFromLine — units_v1 (A3-2)", () => {
  it("seeds a unit-aware line's qty as the CASE COUNT, never the base-piece total", () => {
    const seeded = buildEditItemFromLine(unitLine());
    expect(seeded.qty).toBe(3);
    expect(seeded.originalQty).toBe(3);
    expect(seeded.unitLabel).toBe("Case");
    // boxSplit forced false: a unit line is qty*unitPrice, never re-expanded via boxedDtoFields.
    expect(seeded.boxSplit).toBe(false);
    expect(seeded.originalBoxSplit).toBe(false);
    expect(seeded.unitsPerBox).toBe(192);
  });

  it("leaves a plain boxed (non-unit) line's seeding byte-identical to today", () => {
    const seeded = buildEditItemFromLine(plainBoxedLine());
    expect(seeded.qty).toBe(36); // base pieces, unchanged convention
    expect(seeded.boxSplit).toBe(true);
    expect(seeded.unitLabel).toBeUndefined();
  });
});

describe("buildItemUpdates — units_v1 (A3-2)", () => {
  it("(a) editing a Case line 3 -> 4 emits UPDATE {id, qty:4, unitLabel, productId}, no boxes/pieces", () => {
    const orig = unitLine();
    const edited: EditItemState = { ...buildEditItemFromLine(orig), qty: 4 };
    const updates = buildItemUpdates([edited], [orig]);
    expect(updates).toEqual<ItemUpdate[]>([
      { id: "li-case", action: "UPDATE", qty: 4, unitLabel: "Case", productId: "p-case" },
    ]);
    expect(updates[0]).not.toHaveProperty("boxes");
    expect(updates[0]).not.toHaveProperty("pieces");
  });

  it("(b) a plain line's UPDATE payload is unchanged from today (boxes/pieces, no unitLabel)", () => {
    const orig = plainBoxedLine();
    const edited: EditItemState = { ...buildEditItemFromLine(orig), qty: 48 }; // 3 -> 4 boxes
    const updates = buildItemUpdates([edited], [orig]);
    expect(updates).toEqual<ItemUpdate[]>([
      { id: "li-plain", action: "UPDATE", qty: 48, boxes: 4, pieces: 0 },
    ]);
    expect(updates[0]).not.toHaveProperty("unitLabel");
  });

  it("an untouched Case line produces no update at all (qtyChanged compares against the count, not base pieces)", () => {
    const orig = unitLine();
    const edited = buildEditItemFromLine(orig); // no edits
    expect(buildItemUpdates([edited], [orig])).toEqual([]);
  });

  // B718: a stored unit line carrying a MEANINGLESS boxes:0 must not hydrate as "0 Cases" —
  // `boxes ?? qty` passed the 0 through, so a later price-only edit sent qty:0, which the server
  // silently skips. SERVER-SHAPED fixture (#938 F2 BLOCK on #2220): a unit line's stored `qty` is
  // BASE PIECES (count × unitsPerBox), so 3 Cases of 12 is qty 36 — falling back to `qty` as the
  // count reads 36 Cases and a price-only save re-bills the line as 432 pieces (12×).
  it("B718: a server-shaped 3-Case line (qty 36, boxes 0, unitsPerBox 12) seeds 3 Cases, and a price-only save keeps it 3 Cases / 36 pieces, never 432", () => {
    const orig = unitLine({
      qty: 36,
      boxes: 0,
      unitsPerBox: 12,
      product: { id: "p-case", name: "Widget", unit: "Box", unitsPerBox: 12 },
    });
    const seeded = buildEditItemFromLine(orig);
    const edited: EditItemState = { ...seeded, unitPrice: 45 }; // price-only edit
    const updates = buildItemUpdates([edited], [orig]);
    expect(updates).toHaveLength(1);
    // The UPDATE wire qty for a unit line is the COUNT of the named unit (unitLabel "Case").
    const wireCount = (updates[0] as { qty: number }).qty;
    expect(wireCount).toBe(3); // never 36 (Cases) and never 0
    expect(wireCount * 12).toBe(36); // pieces the server will store — never 432

    expect(seeded.qty).toBe(3);
    expect(seeded.originalQty).toBe(3);
  });
});

// SA-388 (#938, tier 1): ONE count function for a web unit line. `boxes` when a positive integer;
// else `qty ÷ unitsPerBox` (the line's SNAPSHOT factor) when qty is a whole multiple of it; else
// LOCKED — no qty edit, and a price/note-only edit refuses to save (no request is ever built).
// Server-shaped fixtures only: qty is base pieces = count × factor.
describe("unitLineCount — SA-388", () => {
  const caseLine = (qty: number, boxes: number | null, factor = 12) =>
    unitLine({
      qty,
      boxes,
      unitsPerBox: factor,
      product: { id: "p-case", name: "Widget", unit: "Box", unitsPerBox: factor },
    });
  const eachLine = (qty: number, boxes: number | null) =>
    unitLine({
      id: "li-each",
      qty,
      boxes,
      unitsPerBox: 1,
      unitLabel: "Each",
      product: { id: "p-case", name: "Widget", unit: "Each", unitsPerBox: 1 },
    });

  it.each([
    ["factor 12 {qty 36, boxes 3}", 3, caseLine(36, 3)],
    ["factor 12 {qty 36, boxes 0}", 3, caseLine(36, 0)],
    ["factor 12 {qty 36, boxes null}", 3, caseLine(36, null)],
    ['"Each" factor 1 {qty 4, boxes null}', 4, eachLine(4, null)],
  ])("%s ⇒ %i", (_label, count, line) => {
    expect(unitLineCount(line)).toBe(count);
    const seeded = buildEditItemFromLine(line);
    expect(seeded.qty).toBe(count);
    expect(seeded.originalQty).toBe(count);
    expect(seeded.countLocked).toBeFalsy();
  });

  it("{qty 40, boxes 0, factor 12} ⇒ LOCKED: no derivable count", () => {
    expect(unitLineCount(caseLine(40, 0))).toBeNull();
    expect(buildEditItemFromLine(caseLine(40, 0)).countLocked).toBe(true);
  });

  // SA-388b (1): a derived count of 0 is not a valid unit-line count (the server refuses qty ≤ 0),
  // so {qty 0} is LOCKED, never "0 Cases".
  it.each([
    ["{qty 0, boxes 0, factor 12}", caseLine(0, 0)],
    ["{qty 0, boxes null, factor 12}", caseLine(0, null)],
  ])("SA-388b: %s ⇒ LOCKED, never 0 Cases", (_label, line) => {
    expect(unitLineCount(line)).toBeNull();
    const seeded = buildEditItemFromLine(line);
    expect(seeded.countLocked).toBe(true);
    const edited: EditItemState = { ...seeded, unitPrice: 45 };
    expect(findLockedUnitLineEdit([edited], [line])?.id).toBe("li-case");
    expect(() => buildItemUpdates([edited], [line])).toThrow(LockedUnitLineError);
  });

  it.each([
    ["price-only", { unitPrice: 45 }],
    ["note-only", { notes: "leave at the side door" }],
    // SA-388b (2): substituteDtoUpdate carries a count for the line, so a substitution on a
    // LOCKED line is the same class as a price/note edit — refused, no request.
    ["substitution", { substituteProductId: "p-other" }],
  ])("LOCKED: a %s edit is refused and builds no request", (_label, patch) => {
    const orig = caseLine(40, 0);
    const edited: EditItemState = { ...buildEditItemFromLine(orig), ...patch };
    expect(findLockedUnitLineEdit([edited], [orig])?.id).toBe("li-case");
    expect(() => buildItemUpdates([edited], [orig])).toThrow(LockedUnitLineError);
  });

  it("LOCKED: cancelling the line is still allowed (it sends no qty)", () => {
    const orig = caseLine(40, 0);
    const edited: EditItemState = { ...buildEditItemFromLine(orig), cancelled: true };
    expect(findLockedUnitLineEdit([edited], [orig])).toBeUndefined();
    expect(buildItemUpdates([edited], [orig])).toEqual([{ id: "li-case", action: "CANCEL" }]);
  });

  it("an untouched line never reports a change — every fixture, LOCKED included", () => {
    for (const orig of [
      caseLine(36, 3),
      caseLine(36, 0),
      caseLine(36, null),
      eachLine(4, null),
      caseLine(40, 0),
    ]) {
      const seeded = buildEditItemFromLine(orig);
      expect(findLockedUnitLineEdit([seeded], [orig])).toBeUndefined();
      expect(buildItemUpdates([seeded], [orig])).toEqual([]);
    }
  });

  it("promoBaseUnits seeds from the same function: {qty 36, boxes 0, promoFreeUnits 2} ⇒ 3", () => {
    const seeded = buildEditItemFromLine(
      unitLine({
        qty: 36,
        boxes: 0,
        unitsPerBox: 12,
        product: { id: "p-case", name: "Widget", unit: "Box", unitsPerBox: 12 },
        promoFreeUnits: 2,
      }),
    );
    expect(seeded.promoBaseUnits).toBe(3);
  });
});

// SA-378: the BUY_N_GET_M base count is seeded the same way — a unit line's stored boxes:0 must
// not become promoBaseUnits 0 (which disables the rescale and previews the full snapshot).
describe("promoBaseUnits seed — B718 fold (SA-378)", () => {
  it("(i) a server-shaped 6-Case line (qty 72, boxes 0, unitsPerBox 12, promoFreeUnits 2) seeds promoBaseUnits 6; shrinking to 3 previews 1 free unit", () => {
    const seeded = buildEditItemFromLine(
      unitLine({
        qty: 72,
        boxes: 0,
        unitsPerBox: 12,
        product: { id: "p-case", name: "Widget", unit: "Box", unitsPerBox: 12 },
        promoFreeUnits: 2,
      }),
    );
    expect(seeded.promoBaseUnits).toBe(6);
    expect(editLineFreeUnits({ ...seeded, qty: 3 })).toBe(1);
  });

  it("(ii) control: a pack line with boxes 0, pieces 5, promoFreeUnits 1 keeps promoBaseUnits 0", () => {
    const seeded = buildEditItemFromLine(
      plainBoxedLine({ qty: 5, boxes: 0, pieces: 5, promoFreeUnits: 1 }),
    );
    expect(seeded.promoBaseUnits).toBe(0);
  });
});
