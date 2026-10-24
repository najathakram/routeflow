import { readFileSync } from "fs";
import { join } from "path";
import type { ProductUnitLevel } from "@routeflow/types";
import {
  applyPickToDraft,
  applyUnitPick,
  applyBoxEdit,
  startsOnDefaultUnit,
  startNewLineOnDefault,
  buildPackLadder,
  type DraftItem,
} from "../lib/edit-items-draft";

/**
 * The order-edit "add" must start a NEW line on the product's default selling unit, as web's Create Order does
 * (defaultUnitValue/defaultStartOption, both over @routeflow/pricing's defaultSellingLabel).
 */
const lvl = (over: Partial<ProductUnitLevel>) =>
  ({
    id: over.label,
    price: null,
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
    isDefaultSelling: false,
    sortOrder: 0,
    ...over,
  }) as ProductUnitLevel;

const boxed = {
  id: "p1",
  name: "Soda",
  pricePerUnit: "24.00",
  unit: "Case",
  unitsPerBox: 24,
};
const pick = (p: typeof boxed, upb: number | null) =>
  applyPickToDraft({}, "p1", {
    productId: p.id,
    unitsPerBox: upb,
    startPrice: 24,
    catalogPrice: 24,
    name: p.name,
    unit: p.unit,
    level: "BOX",
    packLadder: buildPackLadder({ ...p, unitsPerBox: upb }),
  }).p1 as DraftItem;

const BOX = lvl({ label: "Box", factorToBase: 24, price: "24.00", isDefaultSelling: true });
const PIECE = lvl({ label: "Piece", factorToBase: 1, price: "1.25", isDefaultSelling: true });
const BOX_PLAIN = lvl({ label: "Box", factorToBase: 24, price: "24.00" });
const PIECE_PLAIN = lvl({ label: "Piece", factorToBase: 1, price: "1.25" });

describe("order-edit add starts on the default selling unit", () => {
  it("flags a freshly added line as default-start", () => {
    const item = pick(boxed, 24);
    expect(startsOnDefaultUnit(item)).toBe(true);
  });

  it("boxed product whose default selling unit is BOX starts as 1 box", () => {
    const item = pick(boxed, 24);
    const out = startNewLineOnDefault(item, [BOX, PIECE_PLAIN], 1, 24);
    expect(out.unitLabel).toBe("Box");
    expect(out.qty).toBe(1);
    expect(out.boxes).toBeUndefined();
    expect(startsOnDefaultUnit(out)).toBe(false);
  });

  it("piece-default starts as pieces", () => {
    const item = pick(boxed, 24);
    const out = startNewLineOnDefault(item, [BOX_PLAIN, PIECE], 1, 24);
    expect(out.unitLabel).toBe("Piece");
    expect(out.qty).toBe(1);
    expect(out.unitsPerBox).toBe(1);
  });

  it("a product with no units is unchanged", () => {
    const item = pick(boxed, 24);
    expect(startNewLineOnDefault(item, [], 1, 24)).toEqual(item);
    const plain = pick(boxed, null);
    expect(startNewLineOnDefault(plain, [], 1, 24)).toEqual(plain);
  });

  it("no flagged default level leaves the pack line as it was", () => {
    const item = pick(boxed, 24);
    expect(startNewLineOnDefault(item, [BOX_PLAIN, PIECE_PLAIN], 1, 24)).toEqual(item);
  });

  it("never re-applies once the operator edited the quantity or chose a unit", () => {
    const item = pick(boxed, 24);
    expect(startsOnDefaultUnit(applyBoxEdit(item, 3, 24))).toBe(false);
    expect(startsOnDefaultUnit(applyUnitPick(item, { value: "" } as never, 24))).toBe(false);
    expect(startsOnDefaultUnit({ ...item, unitLabel: "Piece" })).toBe(false);
  });

  it("an existing (hydrated) line is never flagged", () => {
    expect(startsOnDefaultUnit({ ...pick(boxed, 24), startOnDefaultUnit: undefined })).toBe(false);
  });

  it("wiring: the card hands the flag to the picker", () => {
    const card = readFileSync(
      join(__dirname, "..", "components", "edit-items", "DraftItemCard.tsx"),
      "utf8",
    );
    expect(card).toMatch(/startOnDefaultUnit=\{startsOnDefaultUnit\(item\)\}/);
  });
});
