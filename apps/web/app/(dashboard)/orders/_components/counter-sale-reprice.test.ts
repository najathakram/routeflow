import { repriceLines, repriceNote } from "./counter-sale-reprice";
import type { SaleLine } from "./counter-sale-scan";

const tiers = { pricePerUnit: 10, priceTier2: 8 };
const line = (o: Partial<SaleLine>): SaleLine => ({
  tempId: "t",
  productId: "p",
  name: "Item",
  unitPrice: 10,
  qty: 1,
  priceType: "STANDARD",
  tierPrices: tiers,
  ...o,
});

describe("repriceLines (POS-2, display only)", () => {
  it("moves an untouched line to the tier price and marks it SPECIAL", () => {
    const r = repriceLines([line({})], () => 2);
    expect(r.lines[0]).toMatchObject({ unitPrice: 8, priceType: "SPECIAL" });
    expect(r).toMatchObject({ changed: 1, kept: 0 });
  });

  it("never overwrites a hand-priced line and counts it as kept", () => {
    const edited = line({ unitPrice: 9.5, priceEdited: true });
    const r = repriceLines([edited, line({ tempId: "u", productId: "q" })], () => 2);
    expect(r.lines[0]).toBe(edited);
    expect(r.lines[1].unitPrice).toBe(8);
    expect(r).toMatchObject({ changed: 1, kept: 1 });
  });

  it("leaves a line with no tier snapshot alone and returns the same array when nothing changes", () => {
    const legacy = line({ tierPrices: undefined });
    const lines = [legacy, line({})];
    const r = repriceLines(lines, () => 1);
    expect(r.lines).toBe(lines);
    expect(r.changed).toBe(0);
  });

  it("words the note", () => {
    expect(repriceNote("Acme", 2, 0)).toBe("Prices updated for Acme.");
    expect(repriceNote("Acme", 0, 2)).toBe("2 lines kept their prices.");
    expect(repriceNote("Acme", 0, 1)).toBe("1 line kept its price.");
    expect(repriceNote("Acme", 1, 1)).toBe("Prices updated for Acme. 1 line kept its price.");
    expect(repriceNote("Acme", 0, 0)).toBeNull();
  });
});
