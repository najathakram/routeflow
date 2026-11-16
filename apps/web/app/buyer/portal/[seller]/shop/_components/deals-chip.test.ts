import { showsDealsChip } from "./deals-chip";

const c = (total: number, deals: number) => ({ total, collections: { deals } });

describe("showsDealsChip (UX guide B18)", () => {
  it("hides the chip when every product is a deal", () => {
    expect(showsDealsChip(c(5, 5))).toBe(false);
  });
  it("shows the chip when some products are deals", () => {
    expect(showsDealsChip(c(5, 1))).toBe(true);
  });
  it("hides the chip when there are no deals", () => {
    expect(showsDealsChip(c(5, 0))).toBe(false);
  });
});
