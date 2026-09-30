import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateTenantAdminDto } from "./create-tenant-admin.dto";

/**
 * B216: `PlatformAdminController.createTenantAdmin` used to type its body as
 * an inline `{ username: string; email: string; password?: string }` object
 * literal — an inline type literal has no runtime metatype, so NestJS's
 * ValidationPipe skipped every `class-validator` decorator on this route
 * entirely (no validation at all on a body that can set a permanent
 * TENANT_ADMIN password). This is the FIRST test coverage for the real DTO
 * class that restores it.
 */
describe("CreateTenantAdminDto", () => {
  const validDto = {
    username: "acme_admin",
    email: "owner@acme.example",
  };

  it("accepts a valid username/email with no password (auto-generated password path)", async () => {
    const dto = plainToInstance(CreateTenantAdminDto, validDto);
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects a non-email address", async () => {
    const dto = plainToInstance(CreateTenantAdminDto, { ...validDto, email: "not-an-email" });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain("email");
  });

  // Review of PR #778: an earlier version enforced a stricter
  // `^[a-zA-Z0-9_]{3,30}$` regex on username here than the sibling
  // CreateTenantDto.adminUsername (MinLength(3)/MaxLength(50), no charset
  // rule) — a username CreateTenantDto's own admin-creation path already
  // accepts (e.g. containing a period or hyphen) would 400 here for no
  // security reason. Aligned to match.
  it.each(["ab", "x".repeat(51)])(
    "rejects a username outside the 3-50 length range ('%s')",
    async (username) => {
      const dto = plainToInstance(CreateTenantAdminDto, { ...validDto, username });
      const errors = await validate(dto);
      expect(errors.map((e) => e.property)).toContain("username");
    },
  );

  it("accepts a username CreateTenantDto's own regex-free rule already allows (periods, hyphens)", async () => {
    const dto = plainToInstance(CreateTenantAdminDto, { ...validDto, username: "acme.admin-01" });
    expect(await validate(dto)).toHaveLength(0);
  });

  // B216 / B03-class password policy — same platform-wide rule as
  // register-tenant.dto.ts and create-tenant.dto.ts.
  it.each([
    ["too short", "Ab1!"],
    ["no uppercase", "lowercase1!"],
    ["no lowercase", "UPPERCASE1!"],
    ["letters only, no digit/special", "PasswordOnly"],
  ])("rejects %s when a password IS supplied", async (_label, password) => {
    const dto = plainToInstance(CreateTenantAdminDto, { ...validDto, password });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain("password");
  });

  it("accepts a password meeting the complexity rule", async () => {
    const dto = plainToInstance(CreateTenantAdminDto, { ...validDto, password: "SecurePass1" });
    expect(await validate(dto)).toHaveLength(0);
  });
});
