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
import { buildEditItemFromLine, buildItemUpdates, type EditItemState } from "./page";
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

  // B718 (SA-369, mirrors mobile #1343): a stored unit line carrying a MEANINGLESS boxes:0 must
  // not hydrate as "0 Cases" — `boxes ?? qty` passed the 0 through, so a later price-only edit
  // sent qty:0, which the server silently skips (the edit is dropped with no signal).
  it("B718: a stored unit line with boxes:0 seeds its count from qty, and a price-only edit sends qty > 0", () => {
    const orig = unitLine({ qty: 3, boxes: 0 });
    const seeded = buildEditItemFromLine(orig);
    const edited: EditItemState = { ...seeded, unitPrice: 45 }; // price-only edit
    const updates = buildItemUpdates([edited], [orig]);
    expect(updates).toHaveLength(1);
    // The bug's own wrong value: pre-fix this UPDATE carried qty:0.
    expect((updates[0] as { qty: number }).qty).toBe(3);

    expect(seeded.qty).toBe(3);
    expect(seeded.originalQty).toBe(3);
  });
});
