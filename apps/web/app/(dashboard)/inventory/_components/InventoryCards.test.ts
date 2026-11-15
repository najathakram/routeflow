import { stockState } from "./InventoryCards";

describe("stockState (the one rule the table colour and the card status share)", () => {
  it("is out at zero or below, whatever the reorder point", () => {
    expect(stockState({ currentStock: 0, reorderPoint: 10 })).toBe("out");
    expect(stockState({ currentStock: -3, reorderPoint: null })).toBe("out");
  });

  it("is low at or below the reorder point, or at or below 5 with none", () => {
    expect(stockState({ currentStock: 6, reorderPoint: 6 })).toBe("low");
    expect(stockState({ currentStock: 5, reorderPoint: null })).toBe("low");
    expect(stockState({ currentStock: 5, reorderPoint: undefined })).toBe("low");
  });

  it("is ok above the threshold", () => {
    expect(stockState({ currentStock: 7, reorderPoint: 6 })).toBe("ok");
    expect(stockState({ currentStock: 6, reorderPoint: null })).toBe("ok");
  });
});
