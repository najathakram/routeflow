/**
 * SA-1141 / W-989 PR-2, cases 15 and 16 (R7): the footers branch on the document's discount tax base. A NEW document (new
 * invoice, new order, the till) previews with the base the server stamps now; an EXISTING one with the server's wire field.
 * The cutover constant is set to a past instant for 15; production stays null (dark).
 */
let mockFrom: Date | null = null;
jest.mock("@routeflow/pricing", () => ({
  ...jest.requireActual("@routeflow/pricing"),
  get DISCOUNT_PRE_TAX_FROM() {
    return mockFrom;
  },
}));

import {
  invoiceFooterTotals,
  newDocumentDiscountBase,
  wireDiscountBase,
} from "./discount-tax-base";
import { orderBuilderTotals } from "./order-builder-totals";

const LINE = { unitPrice: 100, qty: 1, taxRate: 0.1 };
const footer = (discountBase: Parameters<typeof invoiceFooterTotals>[1]["discountBase"]) => {
  const t = invoiceFooterTotals([LINE], { discount: 20, shipping: 0, discountBase });
  return { tax: t.tax, total: t.total };
};

afterAll(() => {
  mockFrom = null;
});

describe("15: a new document's footer shows the server's case-8 values", () => {
  beforeEach(() => {
    mockFrom = new Date("2020-01-01T00:00:00Z");
  });

  it("the new-invoice footer: tax 8, total 88", () => {
    expect(footer(newDocumentDiscountBase())).toEqual({ tax: 8, total: 88 });
  });

  it("the order builder (a new order): tax 8, total 88", () => {
    const t = orderBuilderTotals([{ unitPrice: 100, qty: 1 }], { taxRatePct: 10, discount: 20 });
    expect({ tax: t.tax, total: t.total }).toEqual({ tax: 8, total: 88 });
  });
});

describe("16: an existing document's footer follows its wire field", () => {
  it("LEGACY_POST_TAX shows the legacy values even after the cutover", () => {
    mockFrom = new Date("2020-01-01T00:00:00Z");
    expect(footer(wireDiscountBase("LEGACY_POST_TAX"))).toEqual({ tax: 10, total: 90 });
  });

  it("an older server that sends no field reads as LEGACY, never from the clock", () => {
    mockFrom = new Date("2020-01-01T00:00:00Z");
    expect(footer(wireDiscountBase(undefined))).toEqual({ tax: 10, total: 90 });
  });

  it("PRE_TAX on the wire shows 8 / 88", () => {
    expect(footer(wireDiscountBase("PRE_TAX"))).toEqual({ tax: 8, total: 88 });
  });

  it("dark (the cutover is null): a new document previews LEGACY, as master", () => {
    mockFrom = null;
    expect(footer(newDocumentDiscountBase())).toEqual({ tax: 10, total: 90 });
  });
});
