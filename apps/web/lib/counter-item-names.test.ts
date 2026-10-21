import { itemNamesLine } from "./counter-item-names";

describe("itemNamesLine", () => {
  it("names the first two items with qty and a plus-n-more tail; qty 1 is bare", () => {
    expect(
      itemNamesLine(
        [
          { name: "Cola 12oz Can", qty: 2 },
          { name: "Ice Bag 10lb", qty: 1 },
          { name: "Chips", qty: 1 },
        ],
        3,
      ),
    ).toBe("Cola 12oz Can ×2, Ice Bag 10lb +1 more");
  });

  it("a boxed line reads in its selling unit, not raw pieces (N4)", () => {
    expect(itemNamesLine([{ name: "Cola 12oz Can", qty: 24, qtyText: "2 Cases" }], 1)).toBe(
      "Cola 12oz Can ×2 Cases",
    );
  });

  it("nothing named -> null", () => {
    expect(itemNamesLine(undefined)).toBeNull();
    expect(itemNamesLine([])).toBeNull();
  });
});
