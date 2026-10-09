import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateTenantDto } from "./create-tenant.dto";

/**
 * SA-738 rule 4 / R16-4: the super-admin create-tenant call carries a REQUIRED, validated IANA
 * `timezone` (no silent New York default). The web time-zone select must land with this change.
 */
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

  it("is required: a body without it is refused", async () => {
    expect(await errorsFor({})).toContain("timezone");
  });

  it("accepts a real IANA zone", async () => {
    expect(await errorsFor({ timezone: "America/Chicago" })).not.toContain("timezone");
    expect(await errorsFor({ timezone: "UTC" })).not.toContain("timezone");
  });

  it.each(["Mars/Phobos", "", "not a zone", 42, null, "+01:00", "EST", "Etc/GMT+5"])(
    "refuses %p",
    async (bad) => {
      expect(await errorsFor({ timezone: bad })).toContain("timezone");
    },
  );
});
