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

  // SA-423 (#938): scale is part of the column's bound exactly as precision is. 12.345 would be
  // stored silently as 12.35, a monetary write the house rule forbids; an operator-entered term is
  // refused, not rounded (advance-payment.dto.ts, product-unit.dto.ts use the same decorator).
  describe.each([
    ["CreateCustomerDto", createPayload],
    ["UpdateCustomerDto", updatePayload],
  ] as const)("%s — creditLimit scale (SA-423)", (_name, payload) => {
    it("SA-423: creditLimit 12.345 (three decimals) is a validation error on the isNumber constraint", async () => {
      const clErrors = creditLimitErrors(
        await validate(payload({ creditLimit: 12.345 }), PIPE_OPTS),
      );
      expect(clErrors.length).toBeGreaterThan(0);
      expect(clErrors[0].constraints?.isNumber).toBeDefined();
    });

    it.each([12.34, 99_999_999.99])("SA-423: creditLimit %d stays valid", async (value) => {
      const errors = await validate(payload({ creditLimit: value }), PIPE_OPTS);
      expect(creditLimitErrors(errors)).toHaveLength(0);
    });
  });

  it('SA-423: CreateCustomerDto creditLimit "abc" (non-number) is a validation error on isNumber', async () => {
    const clErrors = creditLimitErrors(
      await validate(createPayload({ creditLimit: "abc" }), PIPE_OPTS),
    );
    expect(clErrors.length).toBeGreaterThan(0);
    expect(clErrors[0].constraints?.isNumber).toBeDefined();
  });
});
