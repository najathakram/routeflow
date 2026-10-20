import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateCustomerDto } from "./create-customer.dto";
import { UpdateCustomerDto } from "./update-customer.dto";

/**
 * Locks the email-clearing semantics: `email: ""` must transform to null (and
 * validate clean) so the service's `dto.email !== undefined` spread actually
 * clears the stored address. Before the @Transform, the web client dropped an
 * emptied field entirely — a CSV-import sentinel (`…@imported.local`) could
 * never be removed, which kept routing invoice sends into a doomed email path.
 */
describe("UpdateCustomerDto — email clearing", () => {
  const run = async (payload: Record<string, unknown>) => {
    const dto = plainToInstance(UpdateCustomerDto, payload);
    return { dto, errors: await validate(dto) };
  };

  it('transforms email: "" to null and validates clean (the clear path)', async () => {
    const { dto, errors } = await run({ email: "" });
    expect(errors).toHaveLength(0);
    expect(dto.email).toBeNull();
  });

  it("treats whitespace-only the same as empty", async () => {
    const { dto, errors } = await run({ email: "   " });
    expect(errors).toHaveLength(0);
    expect(dto.email).toBeNull();
  });

  it("passes a real email through unchanged", async () => {
    const { dto, errors } = await run({ email: "billing@acmeco.com" });
    expect(errors).toHaveLength(0);
    expect(dto.email).toBe("billing@acmeco.com");
  });

  it("leaves email undefined when the field is absent (no accidental clear)", async () => {
    const { dto, errors } = await run({ businessName: "Acme Wholesale" });
    expect(errors).toHaveLength(0);
    expect(dto.email).toBeUndefined();
  });
});

/** SA-827 PR2: the staff-only customer-wide invoice unit. */
describe("UpdateCustomerDto / CreateCustomerDto — invoiceUnitDefault", () => {
  const opts = { whitelist: true, forbidNonWhitelisted: true };

  it.each(["LEGACY", "PIECES", "PACK"])("update accepts %s", async (value) => {
    const dto = plainToInstance(UpdateCustomerDto, { invoiceUnitDefault: value });
    expect(await validate(dto, opts)).toHaveLength(0);
    expect(dto.invoiceUnitDefault).toBe(value);
  });

  it.each(["pieces", "BOX", "", null, 1])("update rejects %p", async (value) => {
    const dto = plainToInstance(UpdateCustomerDto, { invoiceUnitDefault: value });
    const errors = await validate(dto, opts);
    expect(errors.some((e) => e.property === "invoiceUnitDefault")).toBe(true);
  });

  it("update leaves it undefined when absent", async () => {
    const dto = plainToInstance(UpdateCustomerDto, { businessName: "Acme Wholesale" });
    expect(await validate(dto, opts)).toHaveLength(0);
    expect(dto.invoiceUnitDefault).toBeUndefined();
  });

  it("create accepts PIECES and rejects an unknown value", async () => {
    const base = { username: "acme", businessName: "Acme LLC", contactName: "A Buyer" };
    const ok = plainToInstance(CreateCustomerDto, { ...base, invoiceUnitDefault: "PIECES" });
    expect(await validate(ok, opts)).toHaveLength(0);
    const bad = plainToInstance(CreateCustomerDto, { ...base, invoiceUnitDefault: "BOX" });
    expect((await validate(bad, opts)).some((e) => e.property === "invoiceUnitDefault")).toBe(true);
  });
});
