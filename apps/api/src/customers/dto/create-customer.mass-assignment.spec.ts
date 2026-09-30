import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateCustomerDto } from "./create-customer.dto";

/**
 * B451 Phase A — Strix coverage gap 1: mass assignment on POST /customers
 * (tenantId, role, isAdmin, creditLimit). Reproduces the real global
 * ValidationPipe options (apps/api/src/main.ts:145-149) directly against the
 * live DTO: { whitelist: true, forbidNonWhitelisted: true }.
 */
function attackPayload(extra: Record<string, unknown>) {
  return plainToInstance(CreateCustomerDto, {
    username: "attacker",
    businessName: "Attacker LLC",
    contactName: "A Ttacker",
    ...extra,
  });
}

describe("CreateCustomerDto — mass assignment (B451 gap 1)", () => {
  it.each(["tenantId", "role", "isAdmin"])(
    "REFUTED: %s is not a declared field — forbidNonWhitelisted rejects it (400)",
    async (field) => {
      const instance = attackPayload({ [field]: "attacker-supplied" });
      const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
      const whitelistError = errors.find((e) => e.constraints?.whitelistValidation);
      expect(whitelistError).toBeDefined();
      expect(whitelistError!.property).toBe(field);
    },
  );

  it("REFUTED: isAdmin/role/tenantId together still 400 as a batch — none silently dropped-through", async () => {
    const instance = attackPayload({ tenantId: "other-tenant", role: "OPERATOR", isAdmin: true });
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    const rejectedProps = errors
      .filter((e) => e.constraints?.whitelistValidation)
      .map((e) => e.property)
      .sort();
    expect(rejectedProps).toEqual(["isAdmin", "role", "tenantId"]);
  });

  it("creditLimit IS a declared, bounded field — not a raw pass-through (REFUTED as unbounded mass assignment)", async () => {
    const withinBounds = attackPayload({ creditLimit: 500 });
    expect(
      await validate(withinBounds, { whitelist: true, forbidNonWhitelisted: true }),
    ).toHaveLength(0);

    const negative = attackPayload({ creditLimit: -1 });
    const negErrors = await validate(negative, { whitelist: true, forbidNonWhitelisted: true });
    expect(negErrors.some((e) => e.property === "creditLimit" && e.constraints?.min)).toBe(true);

    const overCap = attackPayload({ creditLimit: 1_000_000_001 });
    const overErrors = await validate(overCap, { whitelist: true, forbidNonWhitelisted: true });
    expect(overErrors.some((e) => e.property === "creditLimit" && e.constraints?.max)).toBe(true);
  });

  it("plain string username still 400s an unknown field even when disguised as camelCase noise", async () => {
    const instance = attackPayload({ isSuperAdmin: true });
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.some((e) => e.property === "isSuperAdmin")).toBe(true);
  });
});
