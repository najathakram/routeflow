import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateTenantDto } from "./create-tenant.dto";

/**
 * Phase 0 Task 10: CreateTenantDto.plan used to be a bare @IsString(), so any string cast
 * straight to the TenantPlan enum at write time — a typo'd plan key silently created a tenant
 * with an invalid `plan` value. It now validates against the live PLAN_KEYS catalog.
 */
describe("CreateTenantDto — plan + trialLengthDays validation", () => {
  const base = {
    slug: "acme-wholesale",
    businessName: "Acme Wholesale",
    adminEmail: "owner@acme.example.com",
    adminUsername: "acme_owner",
  };
  const run = async (overrides: Record<string, unknown>) => {
    const dto = plainToInstance(CreateTenantDto, { ...base, ...overrides });
    return validate(dto);
  };

  it("rejects a plan not in the live catalog", async () => {
    const errors = await run({ plan: "NOT_A_REAL_PLAN" });
    expect(errors.some((e) => e.property === "plan")).toBe(true);
  });

  it("accepts every live catalog plan key", async () => {
    for (const plan of ["STARTER", "GROWTH", "SCALE", "ENTERPRISE"]) {
      const errors = await run({ plan });
      expect(errors.filter((e) => e.property === "plan")).toHaveLength(0);
    }
  });

  it("accepts an omitted plan (defaults to STARTER downstream)", async () => {
    const errors = await run({});
    expect(errors.filter((e) => e.property === "plan")).toHaveLength(0);
  });

  it("rejects a trialLengthDays outside 1-90", async () => {
    const errors = await run({ trialLengthDays: 0 });
    expect(errors.some((e) => e.property === "trialLengthDays")).toBe(true);
    const tooHigh = await run({ trialLengthDays: 91 });
    expect(tooHigh.some((e) => e.property === "trialLengthDays")).toBe(true);
  });

  it("accepts a trialLengthDays override within range", async () => {
    const errors = await run({ trialLengthDays: 30 });
    expect(errors.filter((e) => e.property === "trialLengthDays")).toHaveLength(0);
  });
});

/**
 * B03-class regression coverage: `CreateTenantDto.adminPassword` (the
 * platform-admin "create tenant" form's optional admin password) used to
 * enforce only @MinLength(8) — the identical gap the B03 fix closed on the
 * self-service register-tenant.dto.ts — and had zero test coverage. A
 * SUPER_ADMIN supplying a weak password here creates a permanent
 * TENANT_ADMIN credential (forcePasswordChange is only set when the
 * password is auto-generated), so the same platform-wide policy applies.
 */
const validDto = {
  slug: "acme-distribution",
  businessName: "Acme Distribution",
  adminEmail: "owner@acme.example",
  adminUsername: "acme_admin",
};

describe("CreateTenantDto.adminPassword complexity (B03-class)", () => {
  it("is optional — omitting it entirely still validates (auto-generated password path)", async () => {
    const dto = plainToInstance(CreateTenantDto, validDto);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it.each([
    ["too short", "Ab1!"],
    ["no uppercase — passed before this fix", "lowercase1!"],
    ["no lowercase — passed before this fix", "UPPERCASE1!"],
    ["letters only, no digit/special — passed before this fix", "PasswordOnly"],
  ])("rejects %s when a password IS supplied", async (_label, adminPassword) => {
    const dto = plainToInstance(CreateTenantDto, { ...validDto, adminPassword });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain("adminPassword");
  });

  it.each([
    ["digit", "SecurePass1"],
    ["special char", "SecurePass!"],
  ])("accepts upper+lower with a %s", async (_label, adminPassword) => {
    const dto = plainToInstance(CreateTenantDto, { ...validDto, adminPassword });
    expect(await validate(dto)).toHaveLength(0);
  });
});
