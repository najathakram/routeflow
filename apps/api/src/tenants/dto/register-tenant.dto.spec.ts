import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { RegisterTenantDto } from "./register-tenant.dto";

/**
 * B03 regression coverage: the server-side self-service signup DTO used to
 * enforce only @MinLength(8) — no complexity check at all — while every other
 * password-setting flow (reset-password, buyer register/change-password)
 * required upper+lower+digit-or-special via the same shared regex. That meant
 * a password accepted by self-signup could be rejected the first time its
 * owner tried to reset it, and the web form's (also weaker) client-side rule
 * was the ONLY real gate — calling the public endpoint directly bypassed it
 * entirely. This pins the DTO to the platform-wide policy.
 */
const validDto = {
  slug: "acme-distribution",
  businessName: "Acme Distribution",
  adminEmail: "owner@acme.example",
  adminUsername: "acme_admin",
  adminPassword: "SecurePass1!",
};

describe("RegisterTenantDto password complexity (B03)", () => {
  it.each([
    ["too short", "Ab1!"],
    ["no uppercase — passed before this fix", "lowercase1!"],
    ["no lowercase — passed before this fix", "UPPERCASE1!"],
    ["letters only, no digit/special — passed before this fix", "PasswordOnly"],
  ])("rejects %s", async (_label, adminPassword) => {
    const dto = plainToInstance(RegisterTenantDto, { ...validDto, adminPassword });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain("adminPassword");
  });

  it.each([
    ["digit", "SecurePass1"],
    ["special char", "SecurePass!"],
  ])("accepts upper+lower with a %s", async (_label, adminPassword) => {
    const dto = plainToInstance(RegisterTenantDto, { ...validDto, adminPassword });
    expect(await validate(dto)).toHaveLength(0);
  });
});
