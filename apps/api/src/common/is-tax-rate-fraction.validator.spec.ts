import { readFileSync } from "fs";
import { join } from "path";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { TAX_PERCENT_PRECISION_MESSAGE } from "@routeflow/pricing";
import { CreateInvoiceItemDto } from "../invoices/dto/create-invoice.dto";
import { RecurringInvoiceItemDto } from "../recurring-invoices/dto/create-recurring-invoice.dto";
import { isTaxRateFraction } from "./is-tax-rate-fraction.validator";

/** SA-979: a fraction tax rate with more than 6 decimals is a 400 (the column is Decimal(9,6)). */
const line = { description: "x", qty: 1, unitPrice: 10 };

describe("isTaxRateFraction", () => {
  it.each([0, 1, 0.08875, 0.070625, 0.0875, 0.000001])("accepts %p", (v) => {
    expect(isTaxRateFraction(v)).toBe(true);
  });
  it.each([0.0887555, 1e-7, 0.0000005, 0.1234567])("refuses %p", (v) => {
    expect(isTaxRateFraction(v)).toBe(false);
  });
  it.each(["0.08", null, undefined, NaN, Infinity])("refuses non-number %p", (v) => {
    expect(isTaxRateFraction(v)).toBe(false);
  });
});

describe.each([
  ["invoice line", CreateInvoiceItemDto],
  ["recurring line", RecurringInvoiceItemDto],
])("%s taxRate DTO", (_n, Cls) => {
  const run = async (taxRate: number) =>
    validate(plainToInstance(Cls as new () => object, { ...line, taxRate }));

  it("rejects 7 decimals with the shared copy", async () => {
    const errs = await run(0.0887555);
    expect(errs).toHaveLength(1);
    expect(Object.values(errs[0].constraints ?? {})).toContain(TAX_PERCENT_PRECISION_MESSAGE);
  });
  it.each([0.08875, 0.070625])("accepts %p", async (v) => {
    expect(await run(v)).toHaveLength(0);
  });
});

describe("pin: every fraction taxRate DTO field carries IsTaxRateFraction (shrink-only)", () => {
  it.each([
    "invoices/dto/create-invoice.dto.ts",
    "recurring-invoices/dto/create-recurring-invoice.dto.ts",
  ])("%s", (f) => {
    const src = readFileSync(join(__dirname, "..", f), "utf8");
    const fields = src.match(/^.*\btaxRate\?: number;/gm) ?? [];
    expect(fields.length).toBeGreaterThan(0);
    for (const l of fields) expect(l).toContain("@IsTaxRateFraction()");
  });
});
