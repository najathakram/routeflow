import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateVendorBillDto } from "./create-vendor-bill.dto";

/**
 * B451 gap 4 fix — VendorBillItemDto.qty carries @Min(0). unitCost/
 * unitPrice/lineTotal do NOT (Opus review of #791): a scanned discount or
 * deposit-return line is a legitimate negative cost that real mobile
 * scan-to-bill callers send (see vendor-bill-scan.spec.ts) — @Min(0) there
 * would 400 a real supplier invoice, not stop an attack. The actual guard
 * against a bill netting negative is assertMoneyInvariantsOrThrow on the
 * computed totalOwed (vendor-bills.service.spec.ts), which fires regardless
 * of which individual line carried the negative amount. This spec proves
 * the real global ValidationPipe options (apps/api/src/main.ts:145-149):
 * qty stays bounded, unitCost/unitPrice/lineTotal don't, and a normal create
 * payload — mirroring the web create form
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

  it("rejects a negative qty", async () => {
    const instance = plainToInstance(CreateVendorBillDto, basePayload({ qty: -1 }));
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    const itemErrors = errors.flatMap((e) => e.children ?? []).flatMap((c) => c.children ?? []);
    expect(itemErrors.some((e) => e.property === "qty" && e.constraints?.min)).toBe(true);
  });

  it.each(["unitCost", "unitPrice", "lineTotal"])(
    "allows a negative %s at the DTO layer — a scanned discount/deposit line (Opus review of #791)",
    async (field) => {
      const instance = plainToInstance(CreateVendorBillDto, basePayload({ [field]: -1 }));
      const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
      expect(errors).toHaveLength(0);
    },
  );
});
