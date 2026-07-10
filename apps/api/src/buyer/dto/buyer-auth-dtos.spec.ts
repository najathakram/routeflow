import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { BuyerRegisterDto } from "./buyer-register.dto";
import { BuyerChangePasswordDto } from "./buyer-change-password.dto";
import { BuyerUpdateAccountDto } from "./buyer-update-account.dto";
import { UpdateBuyerProfileDto } from "./update-buyer-profile.dto";
import { BuyerAuthController } from "../buyer-auth.controller";

/**
 * Pins the buyer credential/profile validation surface:
 *  - password complexity matches the staff policy (upper + lower + digit-or-special)
 *  - the change-password / update-profile handlers carry concrete DTO metatypes
 *    (an inline `{ ... }` body type silently disables the global ValidationPipe)
 *  - profile DTOs whitelist contact fields only (F4-001 — a buyer must never be
 *    able to self-assign pricingTier / creditLimit / isTaxExempt / emailVerified)
 */

const validRegister = {
  name: "Jane Smith",
  email: "jane@example.com",
  password: "SecurePass1!",
};

async function whitelistErrors(dto: object): Promise<string[]> {
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((e) => e.property);
}

describe("buyer auth DTO validation", () => {
  describe("BuyerRegisterDto password complexity", () => {
    it.each([
      ["short", "Ab1!"],
      ["no uppercase", "lowercase1!"],
      ["no lowercase", "UPPERCASE1!"],
      ["letters only", "PasswordOnly"],
    ])("rejects %s passwords", async (_label, password) => {
      const dto = plainToInstance(BuyerRegisterDto, { ...validRegister, password });
      const errors = await validate(dto);
      expect(errors.map((e) => e.property)).toContain("password");
    });

    it.each([
      ["digit", "SecurePass1"],
      ["special char", "SecurePass!"],
    ])("accepts upper+lower with a %s", async (_label, password) => {
      const dto = plainToInstance(BuyerRegisterDto, { ...validRegister, password });
      expect(await validate(dto)).toHaveLength(0);
    });
  });

  describe("BuyerChangePasswordDto", () => {
    it("rejects weak new passwords and missing current password", async () => {
      const dto = plainToInstance(BuyerChangePasswordDto, {
        currentPassword: "",
        newPassword: "weakpass",
      });
      const props = (await validate(dto)).map((e) => e.property);
      expect(props).toContain("currentPassword");
      expect(props).toContain("newPassword");
    });

    it("accepts a compliant change", async () => {
      const dto = plainToInstance(BuyerChangePasswordDto, {
        currentPassword: "OldPass1!",
        newPassword: "NewPass1!",
      });
      expect(await validate(dto)).toHaveLength(0);
    });
  });

  describe("profile DTOs whitelist contact fields only (F4-001)", () => {
    it("BuyerUpdateAccountDto rejects BuyerAccount columns outside the whitelist", async () => {
      const dto = plainToInstance(BuyerUpdateAccountDto, {
        name: "Jane",
        emailVerified: true,
        passwordHash: "x",
        email: "attacker@evil.example",
      });
      const props = await whitelistErrors(dto);
      expect(props).toEqual(expect.arrayContaining(["emailVerified", "passwordHash", "email"]));
    });

    it("UpdateBuyerProfileDto rejects seller-controlled commercial terms", async () => {
      const dto = plainToInstance(UpdateBuyerProfileDto, {
        businessName: "Cafe",
        pricingTier: 3,
        isTaxExempt: true,
        creditLimit: 999999,
      });
      const props = await whitelistErrors(dto);
      expect(props).toEqual(expect.arrayContaining(["pricingTier", "isTaxExempt", "creditLimit"]));
    });
  });

  describe("handler bodies carry concrete DTO metatypes (ValidationPipe actually runs)", () => {
    const paramTypes = (method: string): unknown[] =>
      (Reflect.getMetadata(
        "design:paramtypes",
        BuyerAuthController.prototype,
        method,
      ) as unknown[]) ?? [];

    it("changePassword body is BuyerChangePasswordDto", () => {
      expect(paramTypes("changePassword")).toContain(BuyerChangePasswordDto);
    });

    it("updateProfile body is BuyerUpdateAccountDto", () => {
      expect(paramTypes("updateProfile")).toContain(BuyerUpdateAccountDto);
    });
  });
});
