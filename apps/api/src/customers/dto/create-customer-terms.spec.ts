import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateCustomerDto } from "./create-customer.dto";

/**
 * W-1487 (R-345 F4): CreateCustomerDto.defaultPaymentTerms takes a preset or a custom "Net N" (1-365), or ""
 * (no override), and refuses anything stored non-canonically. Same tables as payment-terms-parity.spec.ts runs
 * against UpdateCustomerDto and the tenant default.
 */
const termErrors = async (value: unknown) => {
  const dto = plainToInstance(CreateCustomerDto, {
    username: "acme-buyer",
    businessName: "Acme Wholesale",
    contactName: "A Buyer",
    defaultPaymentTerms: value,
  });
  const errors = await validate(dto);
  return errors.filter((e) => e.property === "defaultPaymentTerms");
};

describe("CreateCustomerDto.defaultPaymentTerms (W-1487)", () => {
  it.each(["Due on Receipt", "Net 7", "Net 90", "Net 21", "Net 365", ""])("accepts %p", async (v) =>
    expect(await termErrors(v)).toHaveLength(0),
  );

  it("accepts the field omitted", async () => {
    expect(await termErrors(undefined)).toHaveLength(0);
  });

  it.each([
    " Net 30 ",
    "Net 30 ",
    " Due on Receipt",
    "Net 30\n",
    "net 21",
    "NET 7",
    "due on receipt",
  ])("refuses non-canonical %p", async (v) => expect(await termErrors(v)).toHaveLength(1));

  it.each(["Net 0", "Net 366", "Net 400", "Net 7.5", "net 30 days", "Net -3", "Net", "30"])(
    "refuses %p",
    async (v) => expect(await termErrors(v)).toHaveLength(1),
  );
});
