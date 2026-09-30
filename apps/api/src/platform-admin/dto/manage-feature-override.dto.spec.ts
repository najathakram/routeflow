import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateFeatureOverrideDto } from "./manage-feature-override.dto";

// Feature grants v2 PR-3 (brief B): `kind` validation only -- default-application (COMP when
// omitted) happens in FeatureOverrideService.create(), not here; see feature-override.service.spec.ts.
describe("CreateFeatureOverrideDto — kind validation", () => {
  const base = { featureKey: "tobacco_dealer", effect: "GRANT", reason: "pilot rollout" };
  const run = async (extra: Record<string, unknown>) => {
    const dto = plainToInstance(CreateFeatureOverrideDto, { ...base, ...extra });
    return validate(dto);
  };

  it("is valid when kind is omitted (default applied downstream, not here)", async () => {
    const errors = await run({});
    expect(errors).toHaveLength(0);
  });

  it("accepts each declared kind value", async () => {
    for (const kind of ["PILOT", "SUPPORT", "COMP", "TRIAL", "GRANDFATHER"]) {
      const errors = await run({ kind });
      expect(errors).toHaveLength(0);
    }
  });

  it("rejects a kind outside the declared set with a 400-worthy validation error", async () => {
    const errors = await run({ kind: "BOGUS" });
    expect(errors).not.toHaveLength(0);
    expect(errors.some((e) => e.property === "kind")).toBe(true);
  });
});
