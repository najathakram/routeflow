import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateInvoiceDto } from "./create-invoice.dto";

/**
 * B451 Phase A — sibling check for gap 2, on the endpoint the registry brief
 * actually named ("invoice create"), as distinct from the SARIF finding's own
 * target (POST/PATCH /orders — see create-order.mass-assignment.spec.ts).
 * Reproduces the real global ValidationPipe options
 * (apps/api/src/main.ts:145-149): { whitelist: true, forbidNonWhitelisted: true }.
 */
function attackPayload(extra: Record<string, unknown>) {
  return plainToInstance(CreateInvoiceDto, {
    customerId: "cust-1",
    items: [{ description: "Widget", qty: 1, unitPrice: 10 }],
    ...extra,
  });
}

describe("CreateInvoiceDto — mass assignment (B451 gap 2 sibling)", () => {
  it.each(["totalAmount", "subtotal", "taxAmount", "status", "tenantId"])(
    "REFUTED: %s is not a declared field — forbidNonWhitelisted rejects it (400)",
    async (field) => {
      const instance = attackPayload({ [field]: "attacker-supplied" });
      const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
      const whitelistError = errors.find((e) => e.constraints?.whitelistValidation);
      expect(whitelistError).toBeDefined();
      expect(whitelistError!.property).toBe(field);
    },
  );
});
