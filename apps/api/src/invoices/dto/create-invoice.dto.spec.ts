import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { StandalonePaymentDto } from "./create-invoice.dto";

/**
 * Post-dated check payments PR-1 — `StandalonePaymentDto.allocations` gains `@ArrayMaxSize(50)`.
 * Additive-only: every real caller allocates to a handful of invoices, so this only ever rejects
 * a malformed/adversarial request that never worked usefully before either.
 */
function baseDto(allocationsCount: number) {
  return plainToInstance(StandalonePaymentDto, {
    customerId: "cust-1",
    totalAmount: 100,
    method: "CASH",
    allocations: Array.from({ length: allocationsCount }, (_, i) => ({
      invoiceId: `inv-${i}`,
      amount: 1,
    })),
  });
}

describe("StandalonePaymentDto.allocations ArrayMaxSize(50)", () => {
  it("REG-PR1-DTO1: accepts exactly 50 allocations", async () => {
    const errors = await validate(baseDto(50));
    expect(errors.filter((e) => e.property === "allocations")).toHaveLength(0);
  });

  it("REG-PR1-DTO2: rejects 51 allocations", async () => {
    const errors = await validate(baseDto(51));
    const allocationErrors = errors.filter((e) => e.property === "allocations");
    expect(allocationErrors).toHaveLength(1);
    expect(allocationErrors[0].constraints).toHaveProperty("arrayMaxSize");
  });

  it("REG-PR1-DTO3: a normal small allocation list is unaffected", async () => {
    const errors = await validate(baseDto(2));
    expect(errors.filter((e) => e.property === "allocations")).toHaveLength(0);
  });
});
