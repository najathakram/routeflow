import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ChangePasswordDto } from "./change-password.dto";
import { ResetPasswordDto } from "./reset-password.dto";
import { SetPasswordDto } from "./set-password.dto";
import { RegisterTenantDto } from "../../tenants/dto/register-tenant.dto";
import { CreateTenantDto } from "../../platform-admin/dto/create-tenant.dto";
import { CreateTenantAdminDto } from "../../platform-admin/dto/create-tenant-admin.dto";
import { BuyerRegisterDto } from "../../buyer/dto/buyer-register.dto";
import { BuyerChangePasswordDto } from "../../buyer/dto/buyer-change-password.dto";
import { BuyerSetPasswordDto } from "../../buyer/dto/buyer-set-password.dto";
import { BuyerResetPasswordDto } from "../../buyer/dto/buyer-reset-password.dto";

/**
 * Every password DTO shares one policy: min 8, an uppercase letter, a lowercase letter, and a number
 * or symbol, where an underscore counts as a symbol (people type it as one; `\W` alone left it out).
 */
const DTOS = [
  ChangePasswordDto,
  ResetPasswordDto,
  SetPasswordDto,
  RegisterTenantDto,
  CreateTenantDto,
  CreateTenantAdminDto,
  BuyerRegisterDto,
  BuyerChangePasswordDto,
  BuyerSetPasswordDto,
  BuyerResetPasswordDto,
];
const FIELDS = ["password", "newPassword", "adminPassword"];

/** The policy (`matches`) failures on any password field, for this password. */
async function policyErrors(dto: new () => object, password: string): Promise<string[]> {
  const body = Object.fromEntries(FIELDS.map((f) => [f, password]));
  const errors = await validate(plainToInstance(dto, body) as object);
  return errors
    .filter((e) => FIELDS.includes(e.property) && e.constraints?.matches)
    .map((e) => e.property);
}

describe.each(DTOS.map((d) => [d.name, d] as const))("%s password policy", (_name, dto) => {
  it('"Test_tenant" is accepted: an underscore counts as a symbol', async () => {
    expect(await policyErrors(dto, "Test_tenant")).toEqual([]);
  });

  it('"test_tenant" is still refused (no uppercase letter), so the rule is checked', async () => {
    expect((await policyErrors(dto, "test_tenant")).length).toBeGreaterThan(0);
  });

  it('"Testtenant" is refused (no number or symbol)', async () => {
    expect((await policyErrors(dto, "Testtenant")).length).toBeGreaterThan(0);
  });
});
