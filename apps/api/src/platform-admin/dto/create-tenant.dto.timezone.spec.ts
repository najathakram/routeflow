import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateTenantDto } from "./create-tenant.dto";

/** SA-738 R16-4: the super-admin create-tenant call carries an optional, validated IANA `timezone`. */
describe("CreateTenantDto.timezone", () => {
  const base = {
    slug: "acme-wholesale",
    businessName: "Acme Wholesale",
    adminEmail: "owner@acme.example",
    adminUsername: "acme_owner",
  };
  const errorsFor = async (extra: Record<string, unknown>) =>
    (await validate(plainToInstance(CreateTenantDto, { ...base, ...extra }))).map(
      (e) => e.property,
    );

  it("is optional", async () => {
    expect(await errorsFor({})).not.toContain("timezone");
  });

  it("accepts a real IANA zone", async () => {
    expect(await errorsFor({ timezone: "America/Chicago" })).not.toContain("timezone");
  });

  it.each(["Mars/Phobos", "", "not a zone", 42])("refuses %p", async (bad) => {
    expect(await errorsFor({ timezone: bad })).toContain("timezone");
  });
});
