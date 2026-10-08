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
    expect(repriceNote("Acme", 0, 2)).toBe("Prices updated for Acme. 2 edited prices kept.");
    expect(repriceNote("Acme", 0, 1)).toBe("Prices updated for Acme. 1 edited price kept.");
    expect(repriceNote("Acme Cafe", 0, 1, "Tier 2")).toBe(
      "Prices updated for Acme Cafe (Tier 2). 1 edited price kept.",
    );
    expect(repriceNote("Acme", 1, 1)).toBe("Prices updated for Acme. 1 edited price kept.");
    expect(repriceNote("Acme", 0, 0)).toBeNull();
    expect(repriceNote("Acme", 2, 0, "Wholesale")).toBe("Prices updated for Acme (Wholesale).");
  });
});

describe("repriceLines: a POS-5 edited price survives a customer pick (the survive rule)", () => {
  // tier 1 = 10.00, tier 2 = 8.00. An admin TYPED a price of 9.00 at tier 1: net 9.00, tierPrice 10.00.
  const edited = (over: Partial<SaleLine> = {}): SaleLine =>
    line({
      unitPrice: 9,
      tierPrice: 10,
      priceEdited: true,
      override: { mode: "set", value: 9 },
      ...over,
    });

  it("keeps the NET price, moves tierPrice to the new tier and counts the line as kept", () => {
    const r = repriceLines([edited(), line({ tempId: "u", productId: "q" })], () => 2);
    expect(r.lines[0]).toMatchObject({
      unitPrice: 9, // the clerk's number wins
      tierPrice: 8,
      priceType: "SPECIAL",
      priceEdited: true,
      override: { mode: "set", value: 9 },
    });
    expect(r.lines[1].unitPrice).toBe(8); // the unedited line re-prices as before
    expect(r).toMatchObject({ changed: 1, kept: 1 });
  });

  it("a kept net equal to the new tier price (within 1/2 cent) is no override: a plain line again", () => {
    const r = repriceLines([edited({ unitPrice: 8.004 })], () => 2);
    expect(r.lines[0]).toMatchObject({ unitPrice: 8, priceType: "SPECIAL" });
    expect("override" in r.lines[0]).toBe(false);
    expect("tierPrice" in r.lines[0]).toBe(false);
    expect("priceEdited" in r.lines[0]).toBe(false);
    expect(r).toMatchObject({ changed: 1, kept: 0 });
  });

  it("an edited line whose tier price did not move is left exactly as it is (same object, nothing kept)", () => {
    const l = edited();
    const lines = [l];
    const r = repriceLines(lines, () => 1);
    expect(r.lines).toBe(lines);
    expect(r).toMatchObject({ changed: 0, kept: 0 });
  });

  it("an edited line whose net stands and only the STANDARD/SPECIAL flag moved is updated silently, never counted as kept", () => {
    // tierPrice already 8 (tier 2's price) but the flag is stale: only the flag moves at tier 2.
    const stale = edited({ tierPrice: 8, priceType: "STANDARD" });
    const lines = [stale];
    const r = repriceLines(lines, () => 2);
    expect(r).toMatchObject({ changed: 0, kept: 0 });
    expect(r.lines).not.toBe(lines);
    expect(r.lines[0]).toMatchObject({
      unitPrice: 9,
      tierPrice: 8,
      priceType: "SPECIAL",
      priceEdited: true,
    });
    expect(repriceNote("Acme", r.changed, r.kept)).toBeNull();
  });

  it("is idempotent: a second pass over its own result changes nothing", () => {
    const once = repriceLines([edited()], () => 2);
    const twice = repriceLines(once.lines, () => 2);
    expect(twice.lines[0]).toBe(once.lines[0]);
    expect(twice).toMatchObject({ changed: 0, kept: 0 });
  });

  it("back to tier 1 restores the struck figure to the tier 1 price and keeps the net", () => {
    const atTier2 = repriceLines([edited()], () => 2).lines;
    const back = repriceLines(atTier2, () => 1);
    expect(back.lines[0]).toMatchObject({ unitPrice: 9, tierPrice: 10, priceType: "STANDARD" });
    expect(back.kept).toBe(1);
  });
});

describe("repriceLines: a percent or dollars-off edit is RE-APPLIED to the new customer's price (R17-3)", () => {
  // tier 1 = 10.00, tier 2 = 8.00 (a special tier). 10% off at tier 1: net 9.00, tierPrice 10.00.
  const off = (
    override: SaleLine["override"],
    net: number,
    over: Partial<SaleLine> = {},
  ): SaleLine => line({ unitPrice: net, tierPrice: 10, priceEdited: true, override, ...over });

  it("10% off follows the customer: 10% off the new tier price, counted as updated, not kept", () => {
    const l = off({ mode: "percent", value: 10, reason: "loyalty" }, 9);
    const r = repriceLines([l], () => 2);
    expect(r.lines[0]).toMatchObject({
      unitPrice: 7.2, // 8.00 less 10%, not the old 9.00
      tierPrice: 8,
      priceType: "SPECIAL",
      priceEdited: true,
      override: { mode: "percent", value: 10, reason: "loyalty" },
    });
    expect(r).toMatchObject({ changed: 1, kept: 0 });
  });

  it("$ off each follows the customer too", () => {
    const l = off({ mode: "amount", value: 1, reason: "loyalty" }, 9);
    const r = repriceLines([l], () => 2);
    expect(r.lines[0]).toMatchObject({ unitPrice: 7, tierPrice: 8 });
    expect(r).toMatchObject({ changed: 1, kept: 0 });
  });

  it("back to the first customer re-applies against THEIR price, from the tier price not the last net", () => {
    const at2 = repriceLines([off({ mode: "percent", value: 10, reason: "x" }, 9)], () => 2).lines;
    const back = repriceLines(at2, () => 1);
    expect(back.lines[0]).toMatchObject({ unitPrice: 9, tierPrice: 10, priceType: "STANDARD" });
  });

  it("a HAND-TYPED price stays exactly as typed", () => {
    const r = repriceLines([off({ mode: "set", value: 9 }, 9)], () => 2);
    expect(r.lines[0]).toMatchObject({ unitPrice: 9, tierPrice: 8 });
    expect(r).toMatchObject({ changed: 0, kept: 1 });
  });

  it("an edit the new customer cannot take (dollars off beyond their price) keeps the net and says kept", () => {
    const l = off({ mode: "amount", value: 9, reason: "x" }, 1);
    const r = repriceLines([l], () => 2); // 9 off an 8.00 price is refused
    expect(r.lines[0]).toMatchObject({ unitPrice: 1, tierPrice: 8 });
    expect(r).toMatchObject({ changed: 0, kept: 1 });
  });

  it("a special-tier customer's edit with no reason on file cannot be re-applied: the net is kept", () => {
    const l = off({ mode: "percent", value: 10 }, 9); // no reason
    const r = repriceLines([l], () => 2);
    expect(r.lines[0]).toMatchObject({ unitPrice: 9, tierPrice: 8 });
    expect(r).toMatchObject({ changed: 0, kept: 1 });
  });

  it("a standard-tier customer needs no reason", () => {
    const at2 = off({ mode: "percent", value: 10 }, 7.2, { tierPrice: 8, priceType: "SPECIAL" });
    const r = repriceLines([at2], () => 1);
    expect(r.lines[0]).toMatchObject({ unitPrice: 9, tierPrice: 10, priceType: "STANDARD" });
    expect(r).toMatchObject({ changed: 1, kept: 0 });
  });

  it("is idempotent: a second pass changes nothing", () => {
    const once = repriceLines([off({ mode: "percent", value: 10, reason: "x" }, 9)], () => 2);
    const twice = repriceLines(once.lines, () => 2);
    expect(twice.lines[0]).toBe(once.lines[0]);
    expect(twice).toMatchObject({ changed: 0, kept: 0 });
  });
});
