/**
 * REG-B730 (SA-1167 R5): mobile could display a unit-sold line but never originate or change one. The wrong
 * value is a mobile line that picks a unit and then sends the save without `unitLabel` (so the server prices
 * it as pack pieces), or a screen with no unit picker mounted. Pure logic plus source pins for the mounts
 * (mobile Jest is node-only).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { buildOrderItemDiff } from "../lib/order-item-diff";
import { applyUnitPick, type DraftItem } from "../lib/edit-items-draft";
import type { UnitOption } from "../lib/unit-options";

const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");

const CASE: UnitOption = {
  value: "Case",
  label: "Case",
  factorToBase: 240,
  kind: "level",
  price: 220,
  listPrice: 220,
};

describe("mobile originates and changes a unit-sold line (units_v1)", () => {
  it("REG-B730: picking a unit on a draft line sets the unit, its own price and a count of 1", () => {
    const packLine: DraftItem = {
      productId: "p-acme",
      qty: 24,
      unitsPerBox: 24,
      unitPrice: 24,
      catalogPrice: 24,
      name: "Acme widget",
    };
    const picked = applyUnitPick(packLine, CASE, 24);
    expect(picked.unitLabel).toBe("Case");
    expect(picked.unitPrice).toBe(220); // the Case's own price, never the pack's 24
    expect(picked.unitBasePrice).toBe(220);
    expect(picked.qty).toBe(1);
  });

  it("REG-B730: a NEW line sold by a unit is sent with its unitLabel and a unit COUNT", () => {
    const out = buildOrderItemDiff({
      catalog: [
        {
          productId: "p-acme",
          qty: 3,
          boxSplit: false,
          unitPrice: 220,
          basePrice: 220,
          unitLabel: "Case",
        },
      ],
      unlisted: [],
      originals: [],
      pendingDeletes: [],
      pendingCancels: [],
    });
    expect(out).toEqual([{ productId: "p-acme", qty: 3, unitLabel: "Case" }]);
  });

  it("REG-B730: an EXISTING line changed to a unit this session sends unitLabel + productId and the count, not pack pieces", () => {
    const out = buildOrderItemDiff({
      catalog: [
        {
          lineId: "l1",
          productId: "p-acme",
          qty: 72, // 3 Cases stored in pack pieces: 3 x 24 would bill as "72 cases"
          boxes: 3,
          boxSplit: false,
          unitPrice: 220,
          basePrice: 220,
          unitLabel: "Case",
        },
      ],
      unlisted: [],
      originals: [{ id: "l1", productId: "p-acme", qty: 24, unitPrice: 220 }],
      pendingDeletes: [],
      pendingCancels: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "l1",
      action: "UPDATE",
      qty: 3,
      unitLabel: "Case",
      productId: "p-acme",
    });
    expect(out[0]).not.toHaveProperty("boxes");
    expect(out[0]).not.toHaveProperty("pieces");
  });

  it("REG-B730: the picker is mounted on both the create row and the edit-items card", () => {
    expect(read("components", "CartRow.tsx")).toMatch(/<UnitPickerRow\b/);
    expect(read("components", "edit-items", "DraftItemCard.tsx")).toMatch(/<UnitPickerRow\b/);
    expect(read("components", "NewOrderScreen.tsx")).toMatch(/onChangeUnit=\{setUnitLabel\}/);
    expect(read("app", "(operator)", "(tabs)", "orders", "[id]", "edit-items.tsx")).toMatch(
      /onSetUnit=\{\(opt\) => setUnitLabel\(key, opt\)\}/,
    );
  });
});
