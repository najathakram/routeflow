import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateCustomerDto } from "./create-customer.dto";
import { UpdateCustomerDto } from "./update-customer.dto";

/**
 * B2191 — Customer.creditLimit is `Decimal(10, 2)` (apps/api/prisma/schema/sales.prisma:163),
 * max 99,999,999.99. CreateCustomerDto's `@Max(1_000_000_000)` and UpdateCustomerDto's wholly
 * unbounded `creditLimit?: number` both let a value the column cannot hold reach Prisma, which
 * throws at the DB and surfaces as a 500 instead of a 400. Reproduces the real global
 * ValidationPipe options (apps/api/src/main.ts:153-158): { whitelist: true, transform: true,
 * forbidNonWhitelisted: true }.
 */
const PIPE_OPTS = { whitelist: true, transform: true, forbidNonWhitelisted: true };

function createPayload(extra: Record<string, unknown>) {
  return plainToInstance(
    CreateCustomerDto,
    {
      username: "acme-wholesale",
      businessName: "Acme Wholesale",
      contactName: "A Buyer",
      ...extra,
    },
    { enableImplicitConversion: true },
  );
}

function updatePayload(extra: Record<string, unknown>) {
  return plainToInstance(UpdateCustomerDto, { ...extra }, { enableImplicitConversion: true });
}

function creditLimitErrors(errors: Awaited<ReturnType<typeof validate>>) {
  return errors.filter((e) => e.property === "creditLimit");
}

describe("CreateCustomerDto / UpdateCustomerDto — creditLimit bound to Decimal(10,2) (B2191)", () => {
  describe("CreateCustomerDto", () => {
    it.each([100_000_000, 999_999_999])(
      "REG-2191: creditLimit %d (over the Decimal(10,2) column max) is a validation error, not a 500",
      async (value) => {
        const errors = await validate(createPayload({ creditLimit: value }), PIPE_OPTS);
        const clErrors = creditLimitErrors(errors);
        expect(clErrors.length).toBeGreaterThan(0);
        expect(clErrors[0].constraints?.max).toBeDefined();
      },
    );

    it("REG-2191: creditLimit 99,999,999.99 (the column max) is valid — no creditLimit error", async () => {
      const errors = await validate(createPayload({ creditLimit: 99_999_999.99 }), PIPE_OPTS);
      expect(creditLimitErrors(errors)).toHaveLength(0);
    });

    it("REG-2191: creditLimit -1 is a validation error", async () => {
      const errors = await validate(createPayload({ creditLimit: -1 }), PIPE_OPTS);
      const clErrors = creditLimitErrors(errors);
      expect(clErrors.length).toBeGreaterThan(0);
      expect(clErrors[0].constraints?.min).toBeDefined();
    });

    it("PIN: creditLimit 0 is valid", async () => {
      const errors = await validate(createPayload({ creditLimit: 0 }), PIPE_OPTS);
      expect(creditLimitErrors(errors)).toHaveLength(0);
    });

    it("PIN: creditLimit 500 is valid", async () => {
      const errors = await validate(createPayload({ creditLimit: 500 }), PIPE_OPTS);
      expect(creditLimitErrors(errors)).toHaveLength(0);
    });

    it("PIN: creditLimit 1_000_000_001 (the existing mass-assignment spec's over-cap case) is still a validation error", async () => {
      const errors = await validate(createPayload({ creditLimit: 1_000_000_001 }), PIPE_OPTS);
      const clErrors = creditLimitErrors(errors);
      expect(clErrors.length).toBeGreaterThan(0);
      expect(clErrors[0].constraints?.max).toBeDefined();
    });
  });

  describe("UpdateCustomerDto", () => {
    it.each([100_000_000, 999_999_999])(
      "REG-2191: creditLimit %d (over the Decimal(10,2) column max) is a validation error, not a 500",
      async (value) => {
        const errors = await validate(updatePayload({ creditLimit: value }), PIPE_OPTS);
        const clErrors = creditLimitErrors(errors);
        expect(clErrors.length).toBeGreaterThan(0);
        expect(clErrors[0].constraints?.max).toBeDefined();
      },
    );

    it("REG-2191: creditLimit 99,999,999.99 (the column max) is valid — no creditLimit error", async () => {
      const errors = await validate(updatePayload({ creditLimit: 99_999_999.99 }), PIPE_OPTS);
      expect(creditLimitErrors(errors)).toHaveLength(0);
    });

    it("REG-2191: creditLimit -1 is a validation error", async () => {
      const errors = await validate(updatePayload({ creditLimit: -1 }), PIPE_OPTS);
      const clErrors = creditLimitErrors(errors);
      expect(clErrors.length).toBeGreaterThan(0);
      expect(clErrors[0].constraints?.min).toBeDefined();
    });

    it('REG-2191: creditLimit "abc" (non-number) is a validation error', async () => {
      const errors = await validate(updatePayload({ creditLimit: "abc" }), PIPE_OPTS);
      const clErrors = creditLimitErrors(errors);
      expect(clErrors.length).toBeGreaterThan(0);
      expect(clErrors[0].constraints?.isNumber).toBeDefined();
    });
  });
});
