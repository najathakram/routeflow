import type { ProductUnitLevel } from "@routeflow/types";
import type { LineItemRowItem } from "@/components/LineItemRow";
import { applyLineUnit } from "@/lib/order-line-unit";
import { buildUnitOptions } from "@/lib/unit-options";
import { lineStockViews } from "@/lib/line-stock";
import { stockLineOfNewOrderLine } from "./stock-availability";

jest.mock("../api-client", () => ({ apiClient: { get: jest.fn() } }));

/**
 * SA-1086 read 2, hold 1, on New Order: a unit line's qty is a COUNT of the unit, and `applyLineUnit` drops the
 * pack's `unitsPerBox`, so the picked option's factor has to ride on the line or the note counts Cases as pieces.
 * These rows go through the REAL `applyLineUnit`, never a hand-built line.
 */
const product = { unit: "Case", unitsPerBox: 12, pricePerUnit: "120.00" };
const level = (label: string, factorToBase: number): ProductUnitLevel => ({
  id: label,
  label,
  factorToBase,
  price: "10.00",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 0,
});
const options = buildUnitOptions(product, [level("Tray", 12)], 1);
const tray = options.find((o) => o.value === "Tray")!;

const packLine = {
  tempId: "t1",
  productId: "p1",
  productName: "Soda",
  unit: "Case",
  qty: 12,
  unitsPerBox: 12,
  boxes: 1,
  pieces: 0,
  sellBy: "case",
  listPrice: 120,
  unitPrice: 120,
  priceType: "STANDARD",
} as unknown as LineItemRowItem;

const avail = (onHand: number) => ({
  allowOversell: true,
  items: [{ productId: "p1", availablePieces: onHand }],
});
const view = (line: LineItemRowItem, onHand: number) =>
  lineStockViews({
    lines: [stockLineOfNewOrderLine(line)],
    availability: avail(onHand),
    failed: false,
    fetching: false,
  }).get("t1");

describe("New Order named-unit line stock", () => {
  it("3 Trays of 12 against 20 pieces is 36 pieces: over, and told as 1 tray and 8 pieces", () => {
    const unit = applyLineUnit(packLine as never, tray, { tier: 1 }) as unknown as LineItemRowItem;
    const line: LineItemRowItem = { ...unit, qty: 3 };
    expect(stockLineOfNewOrderLine(line)).toMatchObject({ unitLabel: "Tray", unitFactor: 12 });
    expect(view(line, 20)).toMatchObject({
      state: "ready",
      level: "low",
      requestedPieces: 36,
      label: "1 tray and 8 pieces left",
    });
  });

  it("choosing the pack again takes the factor off the line", () => {
    const unit = applyLineUnit(packLine as never, tray, { tier: 1 }) as never;
    const pack = options.find((o) => o.kind === "pack")!;
    const back = applyLineUnit(unit, pack, { tier: 1 }) as LineItemRowItem;
    expect(back.unitLabel).toBeUndefined();
    expect(stockLineOfNewOrderLine(back).unitFactor ?? undefined).toBeUndefined();
  });
});
