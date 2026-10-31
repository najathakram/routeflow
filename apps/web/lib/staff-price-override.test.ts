import { applyTypedPrice } from "./staff-price-override";

/** SA-1068 M18: a price typed at the tier is still sent when a memory could book instead. */
describe("applyTypedPrice with a memory that may book", () => {
  const line = { productName: "Widget", listPrice: 12, unitPrice: 15, priceType: "MANUAL" };

  it("no memory: the tier price is no override, as today", () => {
    const next = applyTypedPrice(line, 12);
    expect(next).toMatchObject({ unitPrice: 12, priceType: "STANDARD" });
    expect(next.discountedPrice).toBeUndefined();
  });

  it("a memory may book: list is sent as MANUAL", () => {
    expect(applyTypedPrice(line, 12, { memoryMayBook: true })).toMatchObject({
      discountedPrice: 12,
      unitPrice: 12,
      priceType: "MANUAL",
    });
  });

  it("a memory may book: a tier below list is sent as DISCOUNTED", () => {
    const special = { ...line, specialPrice: 10 };
    expect(applyTypedPrice(special, 10, { memoryMayBook: true })).toMatchObject({
      discountedPrice: 10,
      unitPrice: 10,
      priceType: "DISCOUNTED",
    });
  });

  it("an unlisted line has no memory, so nothing changes", () => {
    const next = applyTypedPrice({ ...line, isUnlisted: true }, 12, { memoryMayBook: true });
    expect(next.discountedPrice).toBeUndefined();
  });
});
