import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
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
