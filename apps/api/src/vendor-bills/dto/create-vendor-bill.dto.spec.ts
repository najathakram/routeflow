import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateVendorBillDto } from "./create-vendor-bill.dto";

/**
 * B451 gap 4 fix — VendorBillItemDto.qty/unitCost/unitPrice/lineTotal now
 * carry @Min(0) (previously unbounded). Proves the real global ValidationPipe
 * options (apps/api/src/main.ts:145-149) reject a negative value on each,
 * while a normal create payload — mirroring the web create form
 * ({ productId?, description, qty, unitCost }) — still passes unchanged.
 */
function basePayload(itemOverrides: Record<string, unknown> = {}) {
  return {
    supplierId: "sup-1",
    billDate: "2026-09-16",
    items: [
      { productId: "prod-1", description: "Flour 25lb", qty: 5, unitCost: 3.5, ...itemOverrides },
    ],
  };
}

describe("CreateVendorBillDto — line item bounds (B451 gap 4)", () => {
  it("passes a normal create payload unchanged", async () => {
    const instance = plainToInstance(CreateVendorBillDto, basePayload());
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  it.each(["qty", "unitCost", "unitPrice", "lineTotal"])("rejects a negative %s", async (field) => {
    const instance = plainToInstance(CreateVendorBillDto, basePayload({ [field]: -1 }));
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    const itemErrors = errors.flatMap((e) => e.children ?? []).flatMap((c) => c.children ?? []);
    expect(itemErrors.some((e) => e.property === field && e.constraints?.min)).toBe(true);
  });
});
