import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateInvoiceItemDto } from "./create-invoice.dto";
import { UpdateInvoiceItemDto } from "./update-invoice.dto";
import { RecurringInvoiceItemDto } from "../../recurring-invoices/dto/create-recurring-invoice.dto";

/**
 * R5-1 (SA-814 §3, B296): a line `taxRate` is a FRACTION (0..1). With no ceiling a percent sent by mistake
 * (8.875) was stored as 887.5%; the column is Decimal(9,6) since the widen and carries a 0..1 CHECK, so the DTO
 * refuses it with a 400 instead of letting the CHECK answer with a 500.
 */
const base = { description: "Widget", qty: 1, unitPrice: 10 };
const errorsFor = async (cls: new () => object, taxRate: unknown) =>
  (await validate(plainToInstance(cls, { ...base, taxRate }) as object))
    .filter((e) => e.property === "taxRate")
    .flatMap((e) => Object.keys(e.constraints ?? {}));

describe.each([
  ["CreateInvoiceItemDto", CreateInvoiceItemDto],
  ["UpdateInvoiceItemDto", UpdateInvoiceItemDto],
  ["RecurringInvoiceItemDto", RecurringInvoiceItemDto],
])("%s.taxRate", (_name, cls) => {
  it.each([0, 0.08875, 0.08875, 1])("accepts the fraction %p", async (v) => {
    expect(await errorsFor(cls as never, v)).toEqual([]);
  });

  it.each([8.875, 1.0001, 887.5])(
    "refuses %p (a percent sent as a fraction) with max",
    async (v) => {
      expect(await errorsFor(cls as never, v)).toContain("max");
    },
  );

  it("still refuses a negative rate", async () => {
    expect(await errorsFor(cls as never, -0.01)).toContain("min");
  });

  it("an omitted rate is fine", async () => {
    const errs = await validate(plainToInstance(cls as never, base) as object);
    expect(errs.filter((e) => e.property === "taxRate")).toEqual([]);
  });
});
