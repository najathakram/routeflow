import { HttpException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { authoredCustomEditLines } from "../invoices/invoice-edit-plan";
import { authoredCustomEntries } from "./custom-line-authoring";
import { assertCustomPricesAllowed, isCustomPricedLine } from "./staff-override";

/** SA-1034 rule 4: which lines are custom, which entries AUTHOR one, and the one 403. */
describe("assertCustomPricesAllowed (SA-1034 rule 4)", () => {
  const refusal = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      return e as HttpException;
    }
    return null;
  };

  it("refuses a custom line with the one 403 when the capability is off", () => {
    const err = refusal(() => assertCustomPricesAllowed([{ productId: null }], false));
    expect(err).toBeInstanceOf(HttpException);
    expect(err?.getStatus()).toBe(403);
    expect(err?.getResponse()).toMatchObject({ code: API_ERROR_CODES.PRICE_EDIT_NOT_PERMITTED });
  });

  it("passes a custom line when the capability is on, and a catalog-only list when it is off", () => {
    expect(refusal(() => assertCustomPricesAllowed([{ productId: undefined }], true))).toBeNull();
    expect(refusal(() => assertCustomPricesAllowed([{ productId: "p1" }], false))).toBeNull();
    expect(refusal(() => assertCustomPricesAllowed([], false))).toBeNull();
  });

  it("a server-priced line (systemKind, e.g. NSF) is not a custom line", () => {
    expect(isCustomPricedLine({ productId: null, systemKind: "NSF_FEE" })).toBe(false);
    expect(isCustomPricedLine({ productId: "", systemKind: null })).toBe(true);
    expect(
      refusal(() => assertCustomPricesAllowed([{ productId: null, systemKind: "NSF_FEE" }], false)),
    ).toBeNull();
  });
});

describe("authoredCustomEntries: which entries of a staff full replace AUTHOR a custom line", () => {
  const held = [
    { id: "l1", productId: null, name: "Pallet fee", unitPrice: "25.00" },
    { id: "l2", productId: "p1", name: "Cola", unitPrice: "10.00" },
  ];
  const entry = (over: Record<string, unknown>) => ({
    name: "Pallet fee",
    qty: 1,
    unitPrice: 25,
    ...over,
  });

  it("a new custom entry (no id, no held twin) authors", () => {
    expect(authoredCustomEntries([entry({ name: "Fuel" })], held)).toHaveLength(1);
  });

  it("a resubmitted, unchanged held custom line does not author (by id, and by name and cents)", () => {
    expect(authoredCustomEntries([entry({ id: "l1" })], held)).toHaveLength(0);
    expect(authoredCustomEntries([entry({})], held)).toHaveLength(0);
  });

  it("a held custom line re-sent at another price authors (by id, and by name)", () => {
    expect(authoredCustomEntries([entry({ id: "l1", unitPrice: 5 })], held)).toHaveLength(1);
    expect(authoredCustomEntries([entry({ unitPrice: 5 })], held)).toHaveLength(1);
  });

  it("an id that is not a held custom line authors; a catalog entry and an unwritable entry never do", () => {
    expect(authoredCustomEntries([entry({ id: "l2" })], held)).toHaveLength(1);
    expect(authoredCustomEntries([entry({ productId: "p1" })], held)).toHaveLength(0);
    expect(authoredCustomEntries([entry({ name: " " })], held)).toHaveLength(0);
    expect(authoredCustomEntries([entry({ qty: 0 })], held)).toHaveLength(0);
    expect(authoredCustomEntries([entry({ unitPrice: null })], held)).toHaveLength(0);
  });

  it("compares prices by roundMoney cents", () => {
    expect(authoredCustomEntries([entry({ id: "l1", unitPrice: 25.004 })], held)).toHaveLength(0);
    expect(authoredCustomEntries([entry({ id: "l1", unitPrice: 25.01 })], held)).toHaveLength(1);
  });
});

describe("authoredCustomEditLines: which lines of an invoice edit AUTHOR a custom price", () => {
  const line = (over: Record<string, unknown>) => ({
    description: "Fee",
    qty: 1,
    unitPrice: 5,
    ...over,
  });
  const match = (row: Record<string, unknown> | null) => ({
    row: row as any,
    untouched: false,
    productChanged: false,
  });

  it("a new custom line, and a stored custom line re-priced, author", () => {
    const items = [line({}), line({ id: "r1", unitPrice: 9 })];
    const matches = [match(null), match({ id: "r1", unitPrice: "5.00", systemKind: null })];
    expect(authoredCustomEditLines(items as any, matches)).toHaveLength(2);
  });

  it("a stored custom line whose price is only echoed back, a catalog line and a systemKind row do not", () => {
    const items = [
      line({ id: "r1", qty: 3 }),
      line({ productId: "p1" }),
      line({ id: "r2", unitPrice: 99 }),
    ];
    const matches = [
      match({ id: "r1", unitPrice: "5.00", systemKind: null }),
      match(null),
      match({ id: "r2", unitPrice: "30.00", systemKind: "NSF_FEE" }),
    ];
    expect(authoredCustomEditLines(items as any, matches)).toHaveLength(0);
  });
});
