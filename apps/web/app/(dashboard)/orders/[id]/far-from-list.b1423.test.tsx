import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { PriceEditRow } from "./price-edit-row";
import { buildNewLine } from "./scan-level-line";
import { buildEditItemFromLine } from "./_components/order-line-edit";
import { lineFarFromListReference } from "./_components/line-far-from-list";

jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));

/**
 * REG-B1423 (ruling SA-1405): the order page's "far from list" note compared with `basePrice`, which is the customer's
 * tier price on a line added on the page and the pre-promo tier price on a promo line, and called it "list". It also
 * spoke on a contract line nobody had touched. One reference (the catalog list price in the line's sold unit) and one
 * skip rule (a price the system set says nothing until someone types one).
 */
const note = () => screen.queryByTestId("price-far-from-list");

/** The price row exactly as the line editor mounts it for this line. */
function rowFor(item: Parameters<typeof lineFarFromListReference>[0] & { basePrice: number }) {
  return renderWithProviders(
    <PriceEditRow
      unitWord="case"
      basePrice={item.basePrice}
      unitPrice={item.unitPrice}
      originalUnitPrice={item.originalUnitPrice}
      listReference={lineFarFromListReference(item)}
      onPriceChange={jest.fn()}
      onReasonChange={jest.fn()}
    />,
  );
}

const product = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  name: "Cola",
  unit: "case",
  unitsPerBox: null,
  pricePerUnit: 10,
  ...over,
});
const newTierLine = (p: Record<string, unknown>, tier: number) =>
  buildNewLine(p, {
    newId: "new-1",
    startPrice: tier,
    base: tier,
    unitScan: false,
    special: false,
  });

const savedLine = (over: Record<string, unknown>) =>
  buildEditItemFromLine({
    id: "li1",
    productId: "p1",
    product: { id: "p1", name: "Cola", unit: "case", unitsPerBox: null },
    qty: 1,
    unitPrice: 10,
    originalPrice: 10,
    priceType: "STANDARD",
    subtotal: 10,
    ...over,
  } as never);

describe("REG-B1423: the order page compares with the catalog list price", () => {
  it("case 1: a tier line added on the page (list 10.00, tier 4.50), 45 typed: 350% above list ($10.00)", () => {
    const typed = { ...newTierLine(product(), 4.5), unitPrice: 45, priceEdited: true };
    rowFor(typed);
    // master: "900% above list ($4.50)", the tier price called list
    expect(note()).toHaveTextContent("350% above list ($10.00)");
  });

  it("case 1b: the same line before anyone types says nothing (the tier price is the system's)", () => {
    rowFor(newTierLine(product(), 4.5));
    expect(note()).toBeNull();
  });

  it("case 2: a saved contract (SPECIAL) line, untouched, list 10.00 and contract 4.50: no note", () => {
    rowFor(savedLine({ unitPrice: 4.5, originalPrice: 10, priceType: "SPECIAL" }));
    // master: "55% below list ($10.00)" as soon as edit opens
    expect(note()).toBeNull();
  });

  it("case 2b: the same contract line once a price is typed compares with the list price", () => {
    rowFor({
      ...savedLine({ unitPrice: 4.5, originalPrice: 10, priceType: "SPECIAL" }),
      unitPrice: 2,
      priceEdited: true,
    });
    expect(note()).toHaveTextContent("80% below list ($10.00)");
  });

  it("case 3: a saved promo line never calls its pre-promo tier price 'list'", () => {
    // originalPrice on a PROMO line is the tier price before the promo (8.00), not the catalog list; the loaded line
    // carries no catalog price, so there is nothing true to compare with.
    const promo = savedLine({ unitPrice: 6, originalPrice: 8, priceType: "PROMO" });
    expect(promo.listReference).toBeNull();
    rowFor({ ...promo, unitPrice: 2, priceEdited: true });
    // master: "75% below list ($8.00)"
    expect(note()).toBeNull();
  });

  it("case 4 (guard): a box of 12 at list 1.00 a piece, box price 12.00: no note", () => {
    const boxed = newTierLine(product({ unitsPerBox: 12, pricePerUnit: 12 }), 12);
    rowFor({ ...boxed, unitPrice: 12, priceEdited: true });
    expect(note()).toBeNull();
  });
});

describe("REG-B1423: which lines have a reference at all", () => {
  it("a saved line someone priced by hand (MANUAL) keeps its note when edit opens", () => {
    const manual = savedLine({ unitPrice: 3, originalPrice: 10, priceType: "MANUAL" });
    expect(lineFarFromListReference(manual)).toBe(10);
  });

  it("a price the system changed this session (a unit pick, a substitute) says nothing until typed", () => {
    const repriced = { ...savedLine({ priceType: "MANUAL", unitPrice: 9 }), unitPrice: 3 };
    expect(lineFarFromListReference(repriced)).toBeNull();
    expect(lineFarFromListReference({ ...repriced, priceEdited: true })).toBe(10);
  });

  it("an unlisted line and a line with no list price have no reference", () => {
    const unlisted = buildEditItemFromLine({
      id: "li2",
      productId: null,
      name: "Pallet fee",
      qty: 1,
      unitPrice: 5,
      priceType: "MANUAL",
      subtotal: 5,
    } as never);
    expect(lineFarFromListReference({ ...unlisted, unitPrice: 50, priceEdited: true })).toBeNull();
    const free = {
      ...newTierLine(product({ pricePerUnit: 0 }), 0),
      unitPrice: 5,
      priceEdited: true,
    };
    expect(lineFarFromListReference(free)).toBeNull();
  });

  it("a loose piece scanned off a boxed product has no reference (its price is per piece, the list per box)", () => {
    const piece = buildNewLine(product({ unitsPerBox: 12, pricePerUnit: 12 }), {
      newId: "new-2",
      startPrice: 1,
      base: 1,
      unitScan: true,
      special: false,
    });
    expect(lineFarFromListReference({ ...piece, unitPrice: 5, priceEdited: true })).toBeNull();
  });
});
