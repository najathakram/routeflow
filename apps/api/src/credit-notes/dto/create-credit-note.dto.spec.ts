import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateCreditNoteDto } from "./create-credit-note.dto";

/**
 * Body DTO — mirrors the shape of apps/api/src/products/dto/product-dto.validation.spec.ts
 * (plainToInstance + async validate, since the global pipe runs transform:true).
 */
describe("CreateCreditNoteDto", () => {
  const build = async (payload: Record<string, unknown>) => {
    const dto = plainToInstance(CreateCreditNoteDto, payload);
    return { dto, errors: await validate(dto) };
  };

  const base = { customerId: "cust-1", amount: 10, reason: "Damaged goods" };

  it("accepts a minimal standalone credit for any customer (no invoice required)", async () => {
    const { errors } = await build(base);
    expect(errors).toHaveLength(0);
  });

  it("rejects amount: 0", async () => {
    const { errors } = await build({ ...base, amount: 0 });
    expect(errors.map((e) => e.property)).toContain("amount");
  });

  it("rejects a negative amount", async () => {
    const { errors } = await build({ ...base, amount: -5 });
    expect(errors.map((e) => e.property)).toContain("amount");
  });

  it("rejects an amount over the 1,000,000 cap", async () => {
    const { errors } = await build({ ...base, amount: 2_000_000 });
    expect(errors.map((e) => e.property)).toContain("amount");
  });

  it("rejects an amount with more than 2 decimal places", async () => {
    const { errors } = await build({ ...base, amount: 10.123 });
    expect(errors.map((e) => e.property)).toContain("amount");
  });

  it("rejects a payload missing customerId", async () => {
    const { errors } = await build({ amount: 10, reason: "Damaged goods" });
    expect(errors.map((e) => e.property)).toContain("customerId");
  });

  it("rejects a malformed expiresAt", async () => {
    const { errors } = await build({ ...base, expiresAt: "not-a-date" });
    expect(errors.map((e) => e.property)).toContain("expiresAt");
  });

  it("rejects a malformed items[] entry (missing invoiceItemId)", async () => {
    const { errors } = await build({ ...base, items: [{ amount: 5 }] });
    expect(errors.map((e) => e.property)).toContain("items");
  });

  // Rollout-critical: with forbidNonWhitelisted active, the currently-deployed web
  // bundle still posts issueDate/notes on every create. If this DTO rejected them,
  // every in-flight client would 400 the moment it deployed.
  it("accepts a payload carrying the deprecated issueDate and notes fields (rollout compatibility)", async () => {
    const { errors } = await build({
      ...base,
      issueDate: "2026-07-30",
      notes: "legacy notes field, silently dropped by the service",
    });
    expect(errors).toHaveLength(0);
  });
});
